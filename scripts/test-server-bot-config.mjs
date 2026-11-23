import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');
const serverEntry = path.join(rootDir, 'dist', 'server.js');
const jwtSecret = 'server-bot-config-test-secret';
const adminUser = 'config_admin';
const normalUser = 'config_user';
const yuelanRoom = 'yuelanroom';
const bot2Room = 'bot20room';
const hostUsers = { [yuelanRoom]: 'yuelan_host', [bot2Room]: 'bot2_host' };

let dataDir;
let server;
let baseUrl;
let adminToken;
const sockets = new Set();
const latestRooms = new Map();
const roomUpdateCounts = new Map();
const timeout = setTimeout(() => {
  console.error('test-server-bot-config: timed out');
  cleanup();
  process.exit(1);
}, 90_000);
timeout.unref();

function cleanup() {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
  }
  for (const socket of sockets) socket.disconnect();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitTcpReady(port) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (
      await new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.once('error', () => {
          socket.destroy();
          resolve(false);
        });
      })
    ) {
      return;
    }
    await sleep(150);
  }
  throw new Error('server did not become ready');
}

async function api(token, method, apiPath, body) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: {
      cookie: `auth_token=${encodeURIComponent(token)}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function prepareUsers() {
  const { UserStore } = await import(pathToFileURL(path.join(rootDir, 'dist', 'auth-store.js')).href);
  const store = new UserStore(dataDir);
  await store.ensureReady();
  for (const username of [adminUser, normalUser, 'yuelan', 'bot2_0', ...Object.values(hostUsers)]) {
    await store.register(username, 'config-test-pass');
  }
  const tokens = {};
  for (const username of [adminUser, normalUser, ...Object.values(hostUsers)]) {
    const sid = await store.rotateSession(username);
    tokens[username] = jwt.sign({ sub: username, sid }, jwtSecret, { expiresIn: '1h' });
  }
  return tokens;
}

async function spawnServer(port) {
  server = spawn(process.execPath, [serverEntry, '--port', String(port)], {
    cwd: rootDir,
    env: {
      ...process.env,
      ROKA_DATA_DIR: dataDir,
      ROKA_STATIC_CDN: '0',
      JWT_SECRET: jwtSecret,
      WEBHOOK_SECRET: 'server-bot-config-webhook-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (chunk) => console.error(`server stderr: ${String(chunk).trim()}`));
  await waitTcpReady(port);
}

function waitRoomUpdate(room, predicate, label, timeoutMs = 15_000) {
  const socket = [...sockets].find((item) => item.hostRoom === room);
  assert.ok(socket, `missing host socket for ${room}`);
  const latest = latestRooms.get(room);
  if (latest && predicate(latest)) return Promise.resolve(latest);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room_update', handler);
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);
    const handler = (data) => {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off('room_update', handler);
      resolve(data);
    };
    socket.on('room_update', handler);
  });
}

async function connectHost(room, token) {
  const socket = ioClient(baseUrl, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  socket.hostRoom = room;
  socket.on('room_update', (data) => {
    latestRooms.set(room, data);
    roomUpdateCounts.set(room, (roomUpdateCounts.get(room) ?? 0) + 1);
  });
  sockets.add(socket);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const joined = waitRoomUpdate(room, (data) => data.players?.length >= 1, `${room} join`);
  socket.emit('join_game_room', { room });
  await joined;
  return socket;
}

async function setSwitches(room, expected) {
  const changed = waitRoomUpdate(
    room,
    (data) => data.allow_team === expected && data.fog === expected && data.multi_line === expected,
    `${room} switches ${expected}`,
  );
  const socket = [...sockets].find((item) => item.hostRoom === room);
  socket.emit('change_game_conf', { allow_team: expected, fog: expected, multi_line: expected });
  await changed;
}

async function assertSwitchesRejected(room) {
  const before = roomUpdateCounts.get(room) ?? 0;
  const socket = [...sockets].find((item) => item.hostRoom === room);
  socket.emit('change_game_conf', { allow_team: true, fog: true, multi_line: true });
  await sleep(500);
  assert.ok((roomUpdateCounts.get(room) ?? 0) > before, `${room} did not answer rejected config`);
  const data = latestRooms.get(room);
  assert.equal(data.allow_team, false, `${room} allow_team must stay locked`);
  assert.equal(data.fog, false, `${room} fog must stay locked`);
  assert.equal(data.multi_line, false, `${room} multi_line must stay locked`);
}

async function startBot(username, room, template) {
  const result = await api(adminToken, 'POST', '/api/admin/bots/start', {
    username,
    room,
    template,
    allowTeam: false,
    allowFog: false,
    allowMultiLine: false,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const joined = waitRoomUpdate(
    room,
    (data) =>
      data.allow_team === false &&
      data.fog === false &&
      data.multi_line === false &&
      data.players?.some(
        (player) =>
          player.uid === username &&
          player.server_bot === true &&
          player.server_bot_allow_team === false &&
          player.server_bot_allow_fog === false &&
          player.server_bot_allow_multi_line === false,
      ),
    `${username} initial restrictions`,
  );
  await joined;
  return result.data.bot;
}

async function updateBot(id, allowTeam, allowFog, allowMultiLine) {
  return api(adminToken, 'POST', '/api/admin/bots/config', {
    id,
    allowTeam,
    allowFog,
    allowMultiLine,
  });
}

async function getBot(username) {
  const result = await api(adminToken, 'GET', '/api/admin/bots');
  assert.equal(result.status, 200);
  return result.data.items.find((bot) => bot.username === username);
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
}

async function main() {
  if (!fs.existsSync(serverEntry)) {
    const built = spawnSync('pnpm', ['run', 'build'], { cwd: rootDir, stdio: 'inherit' });
    assert.equal(built.status, 0, 'build failed');
  }
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-server-bot-config-'));
  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const tokens = await prepareUsers();
  adminToken = tokens[adminUser];
  await spawnServer(port);

  const forbidden = await api(tokens[normalUser], 'POST', '/api/admin/bots/config', {
    id: 'missing',
    allowTeam: true,
    allowFog: true,
    allowMultiLine: true,
  });
  assert.equal(forbidden.status, 403, 'config API must require super admin');

  await connectHost(yuelanRoom, tokens[hostUsers[yuelanRoom]]);
  await connectHost(bot2Room, tokens[hostUsers[bot2Room]]);
  await setSwitches(yuelanRoom, true);
  await setSwitches(bot2Room, true);

  const yuelan = await startBot('yuelan', yuelanRoom, 'simple-strategy-bot');
  await startBot('bot2_0', bot2Room, 'apex-bot');
  await assertSwitchesRejected(yuelanRoom);
  await assertSwitchesRejected(bot2Room);

  const invalidPayloads = [
    { id: yuelan.id, allowFog: true, allowMultiLine: true },
    { id: yuelan.id, allowTeam: 'true', allowFog: true, allowMultiLine: true },
    { id: yuelan.id, allowTeam: 1, allowFog: true, allowMultiLine: true },
    { id: yuelan.id, allowTeam: true, allowFog: 0, allowMultiLine: true },
    { id: yuelan.id, allowTeam: true, allowFog: true, allowMultiLine: null },
  ];
  for (const payload of invalidPayloads) {
    const rejected = await api(adminToken, 'POST', '/api/admin/bots/config', payload);
    assert.equal(rejected.status, 400, `non-boolean config must fail: ${JSON.stringify(payload)}`);
  }
  const missing = await updateBot('missing', true, true, true);
  assert.equal(missing.status, 404);
  assert.equal((await getBot('yuelan')).allowMultiLine, false, 'invalid edits must not change config');

  const enabled = await updateBot(yuelan.id, true, true, true);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.bot.id, yuelan.id, 'edit must not replace the bot');
  assert.equal(enabled.data.bot.startedAt, yuelan.startedAt, 'edit must not restart the bot');
  assert.equal(enabled.data.bot.connected, true, 'edited bot must remain connected');
  const unlocked = waitRoomUpdate(
    yuelanRoom,
    (data) =>
      data.players?.some(
        (player) =>
          player.uid === 'yuelan' &&
          player.server_bot_allow_team === true &&
          player.server_bot_allow_fog === true &&
          player.server_bot_allow_multi_line === true,
      ),
    'yuelan unlocked player flags',
  );
  await unlocked;
  assert.equal(latestRooms.get(yuelanRoom).multi_line, false, 'unlock must not force multi_line on');
  await setSwitches(yuelanRoom, true);

  const disabled = await updateBot(yuelan.id, false, false, false);
  assert.equal(disabled.status, 200, JSON.stringify(disabled.data));
  const locked = waitRoomUpdate(
    yuelanRoom,
    (data) => data.allow_team === false && data.fog === false && data.multi_line === false,
    'yuelan locks close room switches',
  );
  await locked;
  await assertSwitchesRejected(yuelanRoom);

  assert.equal((await updateBot(yuelan.id, true, true, true)).status, 200);
  await setSwitches(yuelanRoom, true);
  const stateFile = path.join(dataDir, 'server-bots.json');
  const backupFile = `${stateFile}.test-backup`;
  fs.renameSync(stateFile, backupFile);
  fs.mkdirSync(stateFile);
  let failedUpdate;
  try {
    failedUpdate = await updateBot(yuelan.id, false, false, false);
  } finally {
    fs.rmSync(stateFile, { recursive: true, force: true });
    fs.renameSync(backupFile, stateFile);
  }
  assert.equal(failedUpdate.status, 500, 'persistence failure must reject the edit');
  const survivingYuelan = await getBot('yuelan');
  assert.equal(survivingYuelan.connected, true, 'failed edit must not disconnect the bot');
  assert.equal(survivingYuelan.id, yuelan.id, 'failed edit must keep the same bot');
  assert.equal(survivingYuelan.allowTeam, true);
  assert.equal(survivingYuelan.allowFog, true);
  assert.equal(survivingYuelan.allowMultiLine, true);
  assert.equal(latestRooms.get(yuelanRoom).multi_line, true, 'failed edit must not change room config');

  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.length, 2);
  assert.deepEqual(
    saved.find((item) => item.username === 'yuelan'),
    {
      username: 'yuelan',
      room: yuelanRoom,
      template: 'simple-strategy-bot',
      allowTeam: true,
      allowFog: true,
      allowMultiLine: true,
    },
  );
  assert.equal(saved.find((item) => item.username === 'bot2_0').allowMultiLine, false);

  await stopServer();
  saved.find((item) => item.username === 'bot2_0').template = 'bot-2.0';
  fs.writeFileSync(stateFile, JSON.stringify(saved));
  for (const socket of sockets) socket.disconnect();
  sockets.clear();
  latestRooms.clear();
  roomUpdateCounts.clear();
  await spawnServer(port);

  const restoreDeadline = Date.now() + 20_000;
  let restoredYuelan;
  let restoredBot2;
  while (Date.now() < restoreDeadline) {
    restoredYuelan = await getBot('yuelan');
    restoredBot2 = await getBot('bot2_0');
    if (restoredYuelan?.connected && restoredBot2?.connected) break;
    await sleep(200);
  }
  assert.equal(restoredYuelan?.connected, true, 'yuelan must reconnect after restore');
  assert.equal(restoredBot2?.connected, true, 'bot2_0 must reconnect after restore');
  assert.equal(restoredBot2.template, 'apex-bot', 'legacy bot state must restore into Apex');
  assert.equal(restoredYuelan.allowTeam, true);
  assert.equal(restoredYuelan.allowFog, true);
  assert.equal(restoredYuelan.allowMultiLine, true, 'edited multi_line permission must survive restart');
  assert.equal(restoredBot2.allowTeam, false);
  assert.equal(restoredBot2.allowFog, false);
  assert.equal(restoredBot2.allowMultiLine, false, 'bot2_0 must remain disallowed after restart');

  await connectHost(yuelanRoom, tokens[hostUsers[yuelanRoom]]);
  await connectHost(bot2Room, tokens[hostUsers[bot2Room]]);
  await setSwitches(yuelanRoom, true);
  await assertSwitchesRejected(bot2Room);

  for (const bot of [restoredYuelan, restoredBot2]) {
    const stopped = await api(adminToken, 'POST', '/api/admin/bots/stop', { id: bot.id });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), []);
  console.log('test-server-bot-config: all assertions passed');
}

main()
  .then(() => {
    clearTimeout(timeout);
    cleanup();
  })
  .catch((error) => {
    clearTimeout(timeout);
    console.error(error.stack || error);
    cleanup();
    process.exitCode = 1;
  });
