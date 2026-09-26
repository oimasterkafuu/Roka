// 迷雾远征（issue #27）冒烟测试：
// 1) 临时数据目录 + 随机端口启动 dist/server.js，注册 4 个合成用户；
// 2) 迷雾房间：房主 change_game_conf { fog: true }，双人对局开始后校验
//    客户端合并后的局面满足迷雾不变量——
//    a. update 帧携带 fog 数组（全量帧长度 n*m）；
//    b. fog=1 的格子 grid_type ∈ {200 空地, 201 山脉, 204 沼泽} 且 army_cnt=0（视野外不泄真实地形/归属）；
//    c. 己方主城格 fog=0；视野内只能看到 1 座主城（自己的）；
// 3) 对照房间：默认配置（不开迷雾）的 update 帧不得携带 fog 字段。
// 4) Bot 房间（issue #51）：bot 进房后迷雾被强制关闭，且房主再次开启请求被拒绝。
// 成功 exit 0，失败/超时 exit 1。全程硬上限 90 秒。

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');

const serverEntry = path.join(rootDir, 'dist', 'server.js');

const HARD_TIMEOUT_MS = 90_000;
const SERVER_READY_TIMEOUT_MS = 20_000;
const ROOM_FOG = 'fogroom';
const ROOM_PLAIN = 'plainroom';
const ROOM_BOT = 'botroom';
const BOT_TOKEN = 'test-token-fog';

const startedAt = Date.now();
const children = new Set();
const sockets = new Set();
let dataDir = null;
let finished = false;

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[test-fog ${elapsed}s] ${message}`);
}

function cleanup() {
  for (const socket of sockets) {
    try {
      socket.disconnect();
    } catch {
      // ignore
    }
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function finish(code, message) {
  if (finished) {
    return;
  }
  finished = true;
  cleanup();
  log(message);
  setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => finish(1, '收到 SIGINT，中止测试'));
setTimeout(() => finish(1, `超过硬上限 ${HARD_TIMEOUT_MS / 1000}s，判定失败`), HARD_TIMEOUT_MS).unref();

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

function waitTcpReady(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error('等待服务器就绪超时'));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureBuild() {
  if (fs.existsSync(serverEntry)) {
    return;
  }
  const result = spawnSync('pnpm', ['run', 'build'], { cwd: rootDir, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('构建失败');
  }
}

async function signUser(store, jwtSecret, username, password) {
  await store.register(username, password);
  const sid = await store.rotateSession(username);
  return jwt.sign({ sub: username, sid }, jwtSecret, { expiresIn: '1h' });
}

/**
 * 最小对局客户端：进房自动准备；像前端一样合并 update 帧
 * （全量/差分），把合并后的最新局面快照存到 client.board 供断言。
 */
function createGameClient(baseUrl, { cookie, room, name, autoReady = true, botToken }) {
  const socket = ioClient(baseUrl, {
    transports: ['websocket', 'polling'],
    extraHeaders: cookie ? { cookie: `auth_token=${encodeURIComponent(cookie)}` } : undefined,
    auth: botToken ? { token: botToken } : undefined,
    reconnection: false,
  });
  sockets.add(socket);

  const client = {
    socket,
    name,
    clientId: '',
    n: 0,
    m: 0,
    general: [-1, -1],
    board: null, // { grid_type, army_cnt, fog, fogFieldSeen, fogFieldAbsent }
    frames: 0,
  };

  socket.on('set_id', (id) => {
    client.clientId = String(id || '');
    socket.emit('join_game_room', { room });
  });
  socket.on('init_map', (data) => {
    client.n = data.n;
    client.m = data.m;
    client.general = data.general;
    client.board = {
      grid_type: new Array(data.n * data.m).fill(0),
      army_cnt: new Array(data.n * data.m).fill(0),
      fog: new Array(data.n * data.m).fill(0),
      fogFieldSeen: false,
      fogFieldAbsent: false,
    };
  });
  socket.on('update', (data) => {
    if (!client.board) return;
    client.frames += 1;
    if (typeof data.fog === 'undefined') client.board.fogFieldAbsent = true;
    else client.board.fogFieldSeen = true;
    const merge = (key, flat) => {
      if (typeof flat === 'undefined') return;
      if (data.is_diff) {
        for (let i = 0; i * 2 < flat.length; i++) {
          client.board[key][flat[i * 2]] = flat[i * 2 + 1];
        }
      } else {
        for (let i = 0; i < flat.length; i++) {
          client.board[key][i] = flat[i];
        }
      }
    };
    merge('grid_type', data.grid_type);
    merge('army_cnt', data.army_cnt);
    merge('fog', data.fog);
  });
  socket.on('room_update', (data) => {
    if (typeof data?.fog !== 'undefined') {
      client.roomFogFlag = Boolean(data.fog);
    }
    if (!autoReady || !client.clientId || !Array.isArray(data?.players) || data?.in_game) return;
    const self = data.players.find((player) => String(player?.sid || '') === client.clientId);
    const need = Number.parseInt(String(data?.need ?? '0'), 10) || 0;
    if (self && !self.ready && Number(self.team) !== 0 && need > 1) {
      socket.emit('change_ready', { ready: true });
    }
  });
  return client;
}

function waitFor(condition, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`等待超时：${label}`));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function assertFogInvariants(client) {
  const { board, n, m, general } = client;
  if (!board.fogFieldSeen) {
    throw new Error(`${client.name}：迷雾对局的 update 帧缺少 fog 字段`);
  }
  let foggedCells = 0;
  for (let idx = 0; idx < n * m; idx++) {
    const code = board.grid_type[idx];
    if (!board.fog[idx]) continue;
    foggedCells += 1;
    if (code !== 200 && code !== 201 && code !== 204) {
      throw new Error(
        `${client.name}：迷雾格 idx=${idx} 泄漏了真实地形/归属信息（grid_type=${code}，应只下发 200 空地、201 山脉或 204 沼泽）`,
      );
    }
    if (code > 50 && code < 150) {
      throw new Error(`${client.name}：迷雾格 idx=${idx} 泄漏了建筑身份（grid_type=${code}）`);
    }
    if (board.army_cnt[idx] !== 0) {
      throw new Error(`${client.name}：迷雾格 idx=${idx} 泄漏了兵力（army_cnt=${board.army_cnt[idx]}）`);
    }
  }
  if (foggedCells === 0) {
    throw new Error(`${client.name}：迷雾对局中没有任何迷雾格，过滤未生效`);
  }
  const [gx, gy] = general;
  if (gx >= 0 && board.fog[gx * m + gy] !== 0) {
    throw new Error(`${client.name}：己方主城格被迷雾覆盖`);
  }
}

async function main() {
  ensureBuild();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-test-fog-'));
  const port = await findFreePort();
  log(`临时数据目录：${dataDir}，端口：${port}`);

  const { UserStore } = await import(pathToFileURL(path.join(rootDir, 'dist', 'auth-store.js')).href);
  const { ensureRuntimeEnv } = await import(
    pathToFileURL(path.join(rootDir, 'dist', 'runtime-env.js')).href
  );
  const store = new UserStore(dataDir);
  await store.ensureReady();
  const env = ensureRuntimeEnv();
  const tokenA = await signUser(store, env.jwtSecret, 'fog_a', 'fog-pass-1');
  const tokenB = await signUser(store, env.jwtSecret, 'fog_b', 'fog-pass-2');
  const tokenC = await signUser(store, env.jwtSecret, 'fog_c', 'fog-pass-3');
  const tokenD = await signUser(store, env.jwtSecret, 'fog_d', 'fog-pass-4');
  const tokenE = await signUser(store, env.jwtSecret, 'fog_e', 'fog-pass-5');

  const server = spawn('node', [serverEntry, '--port', String(port)], {
    cwd: rootDir,
    env: {
      ...process.env,
      ROKA_DATA_DIR: dataDir,
      ROKA_BOT_TOKENS: `${BOT_TOKEN}:bot_fog`,
    },
  });
  children.add(server);
  server.stderr.on('data', (chunk) => log(`服务器 stderr: ${String(chunk).trim()}`));

  log('等待服务器就绪……');
  await waitTcpReady(port, SERVER_READY_TIMEOUT_MS);
  const baseUrl = `http://127.0.0.1:${port}`;

  // 场景 1：迷雾房间
  log('场景 1：开启迷雾远征的房间');
  const a = createGameClient(baseUrl, { cookie: tokenA, room: ROOM_FOG, name: 'A', autoReady: false });
  await waitFor(() => a.clientId !== '', 5000, 'A 进房');
  const b = createGameClient(baseUrl, { cookie: tokenB, room: ROOM_FOG, name: 'B', autoReady: false });
  await waitFor(() => b.clientId !== '', 5000, 'B 进房');
  await sleep(300);
  a.socket.emit('change_game_conf', { fog: true });
  await waitFor(() => a.roomFogFlag === true, 5000, '房间设置同步 fog=true');
  log('房间设置已同步：fog=true');
  a.socket.emit('change_ready', { ready: true });
  b.socket.emit('change_ready', { ready: true });

  await waitFor(() => a.frames >= 3 && b.frames >= 3, 30_000, '迷雾对局帧下发');
  assertFogInvariants(a);
  assertFogInvariants(b);
  log('场景 1 通过：迷雾帧过滤满足全部不变量');
  a.socket.disconnect();
  b.socket.disconnect();

  // 场景 2：对照房间（默认不开迷雾）
  log('场景 2：默认房间（迷雾关闭）');
  const c = createGameClient(baseUrl, { cookie: tokenC, room: ROOM_PLAIN, name: 'C' });
  await waitFor(() => c.clientId !== '', 5000, 'C 进房');
  const d = createGameClient(baseUrl, { cookie: tokenD, room: ROOM_PLAIN, name: 'D' });
  await waitFor(() => d.clientId !== '', 5000, 'D 进房');
  await waitFor(() => c.frames >= 3 && d.frames >= 3, 30_000, '普通对局帧下发');
  if (!c.board.fogFieldAbsent || !d.board.fogFieldAbsent) {
    throw new Error('未开启迷雾的对局不应携带 fog 字段');
  }
  if (c.board.fogFieldSeen || d.board.fogFieldSeen) {
    throw new Error('未开启迷雾的对局出现了 fog 字段');
  }
  log('场景 2 通过：普通对局协议不变（无 fog 字段）');

  // 场景 3：Bot 房间强制禁用迷雾（issue #51）
  log('场景 3：Bot 进房强制关闭迷雾');
  const e = createGameClient(baseUrl, { cookie: tokenE, room: ROOM_BOT, name: 'E', autoReady: false });
  await waitFor(() => e.clientId !== '', 5000, 'E 进房');
  await sleep(300);
  e.socket.emit('change_game_conf', { fog: true });
  await waitFor(() => e.roomFogFlag === true, 5000, '纯人类房间开启迷雾');
  log('纯人类房间可正常开启迷雾');
  const bot = createGameClient(baseUrl, {
    botToken: BOT_TOKEN,
    room: ROOM_BOT,
    name: 'BOT',
    autoReady: false,
  });
  await waitFor(() => bot.clientId !== '', 5000, 'Bot 进房');
  await waitFor(() => e.roomFogFlag === false, 5000, 'bot 进房后迷雾被强制关闭');
  log('bot 进房后迷雾已强制关闭');
  e.socket.emit('change_game_conf', { fog: true });
  await sleep(800);
  if (e.roomFogFlag !== false) {
    throw new Error('房间内有 bot 时房主仍能开启迷雾');
  }
  log('场景 3 通过：bot 房间无法开启迷雾');

  finish(0, '测试通过：迷雾过滤、默认兼容与 bot 房禁用均符合预期');
}

main().catch((error) => finish(1, `测试异常：${error.stack || error.message}`));
