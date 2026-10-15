// 真人客户端验证（[AI] 标记）竞态修复回归测试：
// 临时数据目录起 dist 服务 + socket.io-client 真实连接，覆盖
//   1) 真人 JWT 连接按公式算 sig 后发 client_verify（不进房、不等心跳）→
//      进房后房间列表（room_update）该成员不带 ai 标记；
//   2) 不发 sig 的对照连接带 ai 标记；
//   3) 回归：room_heartbeat 携带 sig 的老路径仍生效。
// 运行：pnpm run test:client-verify（需 dist 产物，缺失时自动 pnpm run build）。

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const jwt = require('jsonwebtoken');

const serverEntry = path.join(rootDir, 'dist', 'server.js');

const HARD_TIMEOUT_MS = 60_000;
const SERVER_READY_TIMEOUT_MS = 20_000;

const startedAt = Date.now();
const sockets = new Set();
let dataDir = null;
let server = null;
let finished = false;

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[test-client-verify ${elapsed}s] ${message}`);
}

function killServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  server.kill('SIGTERM');
  setTimeout(() => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
    }
  }, 2000).unref();
}

function cleanup() {
  for (const socket of sockets) {
    try {
      socket.disconnect();
    } catch {
      // 忽略断开异常
    }
  }
  killServer();
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
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
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => finish(1, '收到 SIGINT，中止测试'));
process.on('SIGTERM', () => finish(1, '收到 SIGTERM，中止测试'));

setTimeout(() => finish(1, `超过硬上限 ${HARD_TIMEOUT_MS / 1000}s，判定失败`), HARD_TIMEOUT_MS).unref();

function ensureBuild() {
  if (fs.existsSync(serverEntry)) {
    return;
  }
  log('dist 产物缺失，先执行 pnpm run build');
  const result = spawnSync('pnpm', ['run', 'build'], { cwd: rootDir, stdio: 'inherit' });
  if (result.status !== 0 || !fs.existsSync(serverEntry)) {
    throw new Error('构建失败，无法运行测试');
  }
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
          reject(new Error(`等待服务器就绪超时（${timeoutMs / 1000}s）`));
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

async function api(baseUrl, cookie, apiPath) {
  const res = await fetch(`${baseUrl}${apiPath}`, {
    headers: { cookie: `auth_token=${encodeURIComponent(cookie)}` },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应
  }
  return { status: res.status, data };
}

function connectSocket(baseUrl, token, label) {
  const { io } = require('socket.io-client');
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 10_000,
    });
    sockets.add(socket);
    // set_id 在连接建立后立即下发，监听器必须在 connect 之前挂上，否则会错过。
    const setIdPromise = new Promise((res) => {
      socket.on('set_id', (data) => res(String(data)));
    });
    socket.on('connect', () => {
      log(`${label} socket 已连接`);
      resolve({ socket, setIdPromise });
    });
    socket.on('connect_error', (error) => reject(new Error(`${label} socket 连接失败：${error.message}`)));
  });
}

// 等待包含目标 sid 的 room_update 并返回该成员的条目。
function waitRoomUpdateFor(socket, sidMd5) {
  return new Promise((resolve) => {
    const handler = (data) => {
      const entry = (data?.players ?? []).find((item) => item.sid === sidMd5);
      if (entry) {
        socket.off('room_update', handler);
        resolve(entry);
      }
    };
    socket.on('room_update', handler);
  });
}

function computeSig(stamp, clientId) {
  return createHash('sha256').update(`${stamp}:${clientId}`).digest('hex');
}

const USER_VERIFY = 'verify_alice'; // 首个注册 = 超管（走 client_verify 新路径）
const USER_PLAIN = 'verify_bob'; // 对照连接（不发 sig）
const USER_HEARTBEAT = 'verify_carol'; // 回归连接（走 room_heartbeat 老路径）

async function main() {
  try {
    ensureBuild();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-client-verify-test-'));

    // 直接用编译产物造用户并签发会话 JWT，绕过注册验证码。
    const { UserStore } = await import(pathToFileURL(path.join(rootDir, 'dist', 'auth-store.js')).href);
    const { ensureRuntimeEnv } = await import(pathToFileURL(path.join(rootDir, 'dist', 'runtime-env.js')).href);
    const store = new UserStore(dataDir);
    await store.ensureReady();
    await store.register(USER_VERIFY, 'verify-pass-1');
    await store.register(USER_PLAIN, 'verify-pass-2');
    await store.register(USER_HEARTBEAT, 'verify-pass-3');
    const env = ensureRuntimeEnv();
    const tokens = {};
    for (const username of [USER_VERIFY, USER_PLAIN, USER_HEARTBEAT]) {
      const sid = await store.rotateSession(username);
      tokens[username] = jwt.sign({ sub: username, sid }, env.jwtSecret, { expiresIn: '1h' });
    }
    log(`已造用户：${USER_VERIFY} / ${USER_PLAIN} / ${USER_HEARTBEAT}`);

    const port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [serverEntry, '--port', String(port)], {
      cwd: rootDir,
      env: { ...process.env, ROKA_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', () => undefined);
    server.stderr.on('data', (chunk) => log(`[server stderr] ${String(chunk).trim()}`));
    await waitTcpReady(port, SERVER_READY_TIMEOUT_MS);
    log(`测试服务器已启动：${baseUrl}`);

    // 取真人会话的 stamp（/api/auth/me）。
    const me = await api(baseUrl, tokens[USER_VERIFY], '/api/auth/me');
    assert.equal(me.status, 200, '/api/auth/me 对已登录会话返回 200');
    assert.equal(typeof me.data?.stamp, 'string', '/api/auth/me 下发 stamp');

    // 场景 1：client_verify 新路径——连接后拿到 set_id 立即发 sig，再进房。
    const { socket: socketVerify, setIdPromise: verifySetIdPromise } = await connectSocket(
      baseUrl,
      tokens[USER_VERIFY],
      'Verify',
    );
    const verifySetId = await verifySetIdPromise;
    socketVerify.emit('client_verify', { sig: computeSig(me.data.stamp, verifySetId) });
    await sleep(300);
    const verifyEntryPromise = waitRoomUpdateFor(socketVerify, verifySetId);
    socketVerify.emit('join_game_room', { room: 'verifyroom' });
    const verifyEntry = await verifyEntryPromise;
    assert.equal(verifyEntry.ai, undefined, 'client_verify 验证后进房不带 ai 标记');
    log('场景 1 通过：client_verify 新路径验证后房间列表不带 ai 标记');

    // 场景 2：对照连接不发任何 sig——同房间成员带 ai 标记。
    const { socket: socketPlain, setIdPromise: plainSetIdPromise } = await connectSocket(
      baseUrl,
      tokens[USER_PLAIN],
      'Plain',
    );
    const plainSetId = await plainSetIdPromise;
    const plainEntryPromise = waitRoomUpdateFor(socketPlain, plainSetId);
    socketPlain.emit('join_game_room', { room: 'verifyroom' });
    const plainEntry = await plainEntryPromise;
    assert.equal(plainEntry.ai, true, '未验证连接在房间列表中带 ai 标记');
    log('场景 2 通过：未验证对照连接带 ai 标记');

    // 场景 3（回归）：room_heartbeat 携带 sig 的老路径仍生效。
    const meHb = await api(baseUrl, tokens[USER_HEARTBEAT], '/api/auth/me');
    const { socket: socketHb, setIdPromise: hbSetIdPromise } = await connectSocket(
      baseUrl,
      tokens[USER_HEARTBEAT],
      'Heartbeat',
    );
    const hbSetId = await hbSetIdPromise;
    socketHb.emit('room_heartbeat', { sig: computeSig(meHb.data.stamp, hbSetId) });
    await sleep(300);
    const hbEntryPromise = waitRoomUpdateFor(socketHb, hbSetId);
    socketHb.emit('join_game_room', { room: 'verifyroom' });
    const hbEntry = await hbEntryPromise;
    assert.equal(hbEntry.ai, undefined, 'room_heartbeat 携带 sig 验证后进房不带 ai 标记');
    log('场景 3 通过：room_heartbeat 老路径回归仍生效');

    finish(0, 'client_verify 测试通过');
  } catch (error) {
    finish(1, `测试失败：${error?.stack ?? error}`);
  }
}

void main();
