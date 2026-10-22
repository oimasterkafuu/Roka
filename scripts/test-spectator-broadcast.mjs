// 观战进出广播文案回归测试（issue #122）：
// 临时数据目录起 dist 服务 + socket.io-client 真实连接，覆盖
//   1) 准备阶段进房 → 广播「×× 加入了自定义房间。」（fold 谓语同步）；
//   2) 准备阶段离房 → 广播「×× 离开了自定义房间。」；
//   3) 对局进行中进房（观战）→ 广播「×× 加入了观战席。」而非「进出了房间」；
//   4) 对局进行中观战离房 → 广播「×× 离开了观战席。」；
//   5) 换队到观战席的既有文案「×× 加入了观战席。」不受影响。
// 运行：pnpm run test:spectator-broadcast（需 dist 产物，缺失时自动 pnpm run build）。

import assert from 'node:assert/strict';
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
  console.log(`[test-spectator-broadcast ${elapsed}s] ${message}`);
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
    socket.on('connect', () => {
      log(`${label} socket 已连接`);
      resolve(socket);
    });
    socket.on('connect_error', (error) => reject(new Error(`${label} socket 连接失败：${error.message}`)));
  });
}

// 等待满足条件的 chat_message，带超时；返回该消息负载。
function waitChatMessage(socket, predicate, description, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('chat_message', handler);
      reject(new Error(`等待聊天消息超时：${description}`));
    }, timeoutMs);
    const handler = (data) => {
      if (predicate(data)) {
        clearTimeout(timer);
        socket.off('chat_message', handler);
        resolve(data);
      }
    };
    socket.on('chat_message', handler);
  });
}

// 等待满足条件的任意事件，带超时。
function waitEvent(socket, event, predicate, description, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`等待事件超时：${description}（${event}）`));
    }, timeoutMs);
    const handler = (data) => {
      if (!predicate || predicate(data)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(data);
      }
    };
    socket.on(event, handler);
  });
}

function joinRoom(socket, room) {
  socket.emit('join_game_room', { room });
}

const USER_A = 'spec_alice';
const USER_B = 'spec_bob';
const USER_C = 'spec_carol';
const USER_D = 'spec_dave';

async function main() {
  try {
    ensureBuild();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-spectator-broadcast-test-'));

    // 直接用编译产物造用户并签发会话 JWT，绕过注册验证码。
    const { UserStore } = await import(pathToFileURL(path.join(rootDir, 'dist', 'auth-store.js')).href);
    const { ensureRuntimeEnv } = await import(pathToFileURL(path.join(rootDir, 'dist', 'runtime-env.js')).href);
    const store = new UserStore(dataDir);
    await store.ensureReady();
    for (const [username, password] of [
      [USER_A, 'spec-pass-1'],
      [USER_B, 'spec-pass-2'],
      [USER_C, 'spec-pass-3'],
      [USER_D, 'spec-pass-4'],
    ]) {
      await store.register(username, password);
    }
    const env = ensureRuntimeEnv();
    const tokens = {};
    for (const username of [USER_A, USER_B, USER_C, USER_D]) {
      const sid = await store.rotateSession(username);
      tokens[username] = jwt.sign({ sub: username, sid }, env.jwtSecret, { expiresIn: '1h' });
    }
    log(`已造用户：${USER_A} / ${USER_B} / ${USER_C} / ${USER_D}`);

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

    // 场景 1/2：准备阶段普通进出房间文案不受影响。
    const socketD = await connectSocket(baseUrl, tokens[USER_D], 'Dave');
    joinRoom(socketD, 'plainroom');
    const joinPlain = await waitChatMessage(
      socketD,
      (data) => data.text === `${USER_D} 加入了自定义房间。`,
      'Dave 进房广播',
    );
    assert.deepEqual(
      joinPlain.fold,
      { name: USER_D, verb: '加入了自定义房间。' },
      '准备阶段进房 fold 谓语保持「加入了自定义房间。」',
    );
    const socketA = await connectSocket(baseUrl, tokens[USER_A], 'Alice');
    joinRoom(socketA, 'plainroom');
    await waitChatMessage(
      socketD,
      (data) => data.text === `${USER_A} 加入了自定义房间。`,
      'Alice 进房广播',
    );
    const leavePlainPromise = waitChatMessage(
      socketD,
      (data) => data.text === `${USER_A} 离开了自定义房间。`,
      'Alice 离房广播',
    );
    socketA.disconnect();
    const leavePlain = await leavePlainPromise;
    assert.deepEqual(
      leavePlain.fold,
      { name: USER_A, verb: '离开了自定义房间。' },
      '准备阶段离房 fold 谓语保持「离开了自定义房间。」',
    );
    socketD.disconnect();
    log('场景 1/2 通过：准备阶段进出房间文案不受影响');

    // 场景 3/4：对局进行中进房 = 观战席文案；观战离房 = 观战席文案。
    const socket1 = await connectSocket(baseUrl, tokens[USER_A], 'Alice');
    const socket2 = await connectSocket(baseUrl, tokens[USER_B], 'Bob');
    joinRoom(socket1, 'specroom');
    await waitChatMessage(socket1, (data) => data.text === `${USER_A} 加入了自定义房间。`, '房主进房广播');
    joinRoom(socket2, 'specroom');
    await waitChatMessage(socket1, (data) => data.text === `${USER_B} 加入了自定义房间。`, 'Bob 进房广播');

    const startPromise = waitEvent(socket1, 'init_map', null, '对局开始');
    socket1.emit('change_ready', { ready: true });
    socket2.emit('change_ready', { ready: true });
    await startPromise;
    log('对局已开始');

    const socket3 = await connectSocket(baseUrl, tokens[USER_C], 'Carol');
    const joinSpecPromise = waitChatMessage(
      socket1,
      (data) => typeof data.text === 'string' && data.text.startsWith(`${USER_C} 加入了`),
      'Carol 观战进房广播',
    );
    joinRoom(socket3, 'specroom');
    const joinSpec = await joinSpecPromise;
    assert.equal(joinSpec.text, `${USER_C} 加入了观战席。`, '对局进行中进房应广播「加入了观战席。」');
    assert.deepEqual(
      joinSpec.fold,
      { name: USER_C, verb: '加入了观战席。' },
      '观战进房 fold 谓语为「加入了观战席。」',
    );
    log('场景 3 通过：对局进行中进房广播「加入了观战席。」');

    const leaveSpecPromise = waitChatMessage(
      socket1,
      (data) => typeof data.text === 'string' && data.text.startsWith(`${USER_C} 离开了`),
      'Carol 观战离房广播',
    );
    socket3.disconnect();
    const leaveSpec = await leaveSpecPromise;
    assert.equal(leaveSpec.text, `${USER_C} 离开了观战席。`, '观战离房应广播「离开了观战席。」');
    assert.deepEqual(
      leaveSpec.fold,
      { name: USER_C, verb: '离开了观战席。' },
      '观战离房 fold 谓语为「离开了观战席。」',
    );
    log('场景 4 通过：观战离房广播「离开了观战席。」');

    // 场景 5：换队到观战席的既有文案不受影响（对局中非存活参赛者允许换队；
    // 中途进房的 Dave 大厅队伍默认 1，换到 0 队即触发换队广播）。
    const socket5 = await connectSocket(baseUrl, tokens[USER_D], 'Dave');
    joinRoom(socket5, 'specroom');
    await waitChatMessage(socket1, (data) => data.text === `${USER_D} 加入了观战席。`, 'Dave 观战进房广播');
    const switchPromise = waitChatMessage(
      socket1,
      (data) => data.text === `${USER_D} 加入了观战席。`,
      'Dave 换队观战广播',
    );
    socket5.emit('change_team', { team: 0 });
    const switchMsg = await switchPromise;
    assert.equal(switchMsg.text, `${USER_D} 加入了观战席。`, '换队到观战席文案保持「加入了观战席。」');
    assert.deepEqual(
      switchMsg.fold,
      { name: USER_D, verb: '加入了观战席。' },
      '换队观战 fold 谓语保持「加入了观战席。」',
    );
    log('场景 5 通过：换队到观战席文案不受影响');

    socket5.disconnect();
    socket1.disconnect();
    socket2.disconnect();
    finish(0, '观战进出广播文案测试通过');
  } catch (error) {
    finish(1, `测试失败：${error?.stack ?? error}`);
  }
}

main();
