// Roka 统一在线状态（presence）测试：
// 第一部分（单元）：假时钟直接驱动 dist/server/presence-service.js，覆盖
//   活动刷新、过期判离线、去重计数、离线↔在线转换、节流落盘与兜底落盘、
//   「刚刚在线」列表、seed 重启恢复；
// 第二部分（集成）：临时数据目录 + 随机端口启动 dist/server.js，验证
//   任意 API 请求刷新「最后在线」、socket 连接去重计数、bot 连接不计入在线、
//   重启后从落盘 lastSeenAt 恢复（seed）。
// 成功 exit 0，失败/超时 exit 1。全程硬上限 60 秒（不跑对局）。

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
const presenceEntry = path.join(rootDir, 'dist', 'server', 'presence-service.js');

const HARD_TIMEOUT_MS = 60_000;
const SERVER_READY_TIMEOUT_MS = 20_000;

const startedAt = Date.now();
const children = new Set();
const sockets = new Set();
let dataDir = null;
let finished = false;
let failures = 0;

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[test-presence ${elapsed}s] ${message}`);
}

function assert(condition, label) {
  if (!condition) {
    failures += 1;
    log(`断言失败：${label}`);
    throw new Error(`断言失败：${label}`);
  }
  log(`通过：${label}`);
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
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
  for (const child of children) {
    killChild(child);
  }
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      log(`已清理临时数据目录 ${dataDir}`);
    } catch (error) {
      log(`清理临时数据目录失败：${error.message}`);
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
process.on('SIGTERM', () => finish(1, '收到 SIGTERM，中止测试'));

setTimeout(() => finish(1, `超过硬上限 ${HARD_TIMEOUT_MS / 1000}s，判定失败`), HARD_TIMEOUT_MS).unref();

function ensureBuild() {
  if (fs.existsSync(serverEntry) && fs.existsSync(presenceEntry)) {
    return;
  }
  log('dist 产物缺失，先执行 pnpm run build');
  const result = spawnSync('pnpm', ['run', 'build'], { cwd: rootDir, stdio: 'inherit' });
  if (result.status !== 0 || !fs.existsSync(presenceEntry)) {
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

async function api(baseUrl, cookie, method, apiPath, body) {
  const res = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: {
      cookie: `auth_token=${encodeURIComponent(cookie)}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应
  }
  return { status: res.status, data };
}

// ---------- 第一部分：presence-service 单元测试（假时钟） ----------

async function runUnitTests() {
  const { PresenceService } = await import(pathToFileURL(presenceEntry).href);
  const WINDOW = 5 * 60_000;
  const PERSIST_INTERVAL = 60_000;

  let now = 1_000_000;
  const persisted = [];
  const presence = new PresenceService({
    onlineWindowMs: WINDOW,
    persistIntervalMs: PERSIST_INTERVAL,
    now: () => now,
    persist: (username, lastSeenAt) => persisted.push([username, lastSeenAt]),
  });

  // 活动刷新：首次 touch 判上线（离线→在线返回 true）并立即落盘。
  assert(presence.touch('Alice') === true, '首次 touch 返回离线→在线转换');
  assert(presence.isOnline('Alice'), 'touch 后用户在线');
  assert(presence.countOnline() === 1, '在线人数为 1');
  assert(presence.getLastSeen('Alice') === now, '「最后在线」= 最近活动时间');
  assert(persisted.length === 1 && persisted[0][0] === 'Alice' && persisted[0][1] === now, '首次 touch 立即落盘');

  // 去重计数：同一用户反复 touch 只计一次；节流间隔内不重复落盘。
  now += 10_000;
  assert(presence.touch('Alice') === false, '在线中再次 touch 不重复上报转换');
  assert(presence.countOnline() === 1, '同一用户多次 touch 只计一次（去重）');
  assert(persisted.length === 1, '节流间隔内不重复落盘');
  assert(presence.getLastSeen('alice') === now, '用户名大小写不敏感');

  // 第二个用户上线；节流间隔过后 Alice 再次 touch 触发落盘。
  now += 10_000;
  presence.touch('Bob');
  assert(presence.countOnline() === 2, '两个用户在线人数为 2');
  now += 50_000;
  presence.touch('Alice');
  assert(persisted.length === 3 && persisted[2][0] === 'Alice' && persisted[2][1] === now, '节流间隔过后再次落盘');

  // Alice 在节流间隔内又活动了一次（lastSeenAt 未落盘），随后双方一起过期。
  now += 10_000;
  presence.touch('Alice');
  const aliceLastSeen = now;
  now += WINDOW + 1_000;
  const expired = presence.sweep();
  assert(expired.includes('Alice') && expired.includes('Bob'), 'sweep 返回掉出在线窗口的用户');
  assert(presence.countOnline() === 0, '过期后在线人数归零');
  assert(!presence.isOnline('Alice') && !presence.isOnline('Bob'), '过期判离线');
  assert(
    persisted.length === 4 && persisted[3][0] === 'Alice' && persisted[3][1] === aliceLastSeen,
    'sweep 对掉线用户兜底落盘最后活动时间',
  );

  // 「刚刚在线」：排除当前在线者、按最后在线倒序。
  presence.touch('Bob'); // Bob 重新上线（离线→在线）
  const recent = presence.listRecentlySeen(8);
  assert(recent.length === 1 && recent[0].username === 'Alice', '「刚刚在线」排除当前在线用户');
  assert(recent[0].lastSeenAt === aliceLastSeen, '「刚刚在线」条目的时间为最后活动时间');

  // 过期后再次 touch 重新判为上线转换。
  now += WINDOW + 1_000;
  presence.sweep();
  assert(presence.touch('Alice') === true, '过期后再次 touch 重新返回上线转换');

  // seed 重启恢复：窗口内的记录恢复为在线，窗口外的进「刚刚在线」。
  const restored = new PresenceService({ onlineWindowMs: WINDOW, now: () => now });
  restored.seed([
    { username: 'Carol', lastSeenAt: now - 1_000 },
    { username: 'Dave', lastSeenAt: now - WINDOW - 5_000 },
  ]);
  assert(restored.isOnline('Carol') && restored.countOnline() === 1, 'seed 恢复窗口内用户为在线');
  assert(!restored.isOnline('Dave'), 'seed 恢复窗口外用户为离线');
  const restoredRecent = restored.listRecentlySeen(8);
  assert(restoredRecent.length === 1 && restoredRecent[0].username === 'Dave', 'seed 后「刚刚在线」只含离线用户');
}

// ---------- 第二部分：集成测试（真实服务器） ----------

const ALICE = 'presence_alice'; // 首个注册 = 超管
const BOB = 'presence_bob';
const CAROL = 'presence_carol';
const BOT_TOKEN = 'presence-bot-token';
const BOT_USER = 'presence_bot';

async function prepareUsers(dir) {
  // 直接用编译产物造用户，绕过注册验证码（超管 = 首个注册用户）。
  const { UserStore } = await import(pathToFileURL(path.join(rootDir, 'dist', 'auth-store.js')).href);
  const { ensureRuntimeEnv } = await import(pathToFileURL(path.join(rootDir, 'dist', 'runtime-env.js')).href);
  const store = new UserStore(dir);
  await store.ensureReady();
  await store.register(ALICE, 'presence-pass-1');
  await store.register(BOB, 'presence-pass-2');
  await store.register(CAROL, 'presence-pass-3');
  // Carol 历史上活跃过（2 小时前），用于验证 seed 恢复 + 「刚刚在线」列表。
  await store.setLastSeenAt(CAROL, Date.now() - 2 * 3600_000);
  const aliceSid = await store.rotateSession(ALICE);
  const bobSid = await store.rotateSession(BOB);
  const env = ensureRuntimeEnv();
  return {
    aliceToken: jwt.sign({ sub: ALICE, sid: aliceSid }, env.jwtSecret, { expiresIn: '1h' }),
    bobToken: jwt.sign({ sub: BOB, sid: bobSid }, env.jwtSecret, { expiresIn: '1h' }),
  };
}

async function lastSeenOf(baseUrl, adminToken, username) {
  const res = await api(baseUrl, adminToken, 'GET', '/api/admin/users');
  assert(res.status === 200, '超管可拉取用户列表');
  const entry = (res.data?.items ?? []).find((item) => item.username === username);
  return entry?.lastSeenAt ?? null;
}

async function onlineCount(baseUrl, token) {
  const res = await api(baseUrl, token, 'GET', '/api/online');
  assert(res.status === 200, '可查询 /api/online');
  return res.data;
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

async function runIntegrationTests() {
  ensureBuild();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-presence-test-'));
  const { aliceToken, bobToken } = await prepareUsers(dataDir);
  log(`已造用户：${ALICE}（超管）/ ${BOB} / ${CAROL}（历史活跃）`);

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [serverEntry, '--port', String(port)], {
    cwd: rootDir,
    env: { ...process.env, ROKA_DATA_DIR: dataDir, ROKA_BOT_TOKENS: `${BOT_TOKEN}:${BOT_USER}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(server);
  server.stdout.on('data', () => undefined);
  server.stderr.on('data', (chunk) => log(`[server stderr] ${String(chunk).trim()}`));
  await waitTcpReady(port, SERVER_READY_TIMEOUT_MS);
  log(`测试服务器已启动：${baseUrl}`);

  // seed 恢复：Carol 从未在本次启动后活动，但应出现在「刚刚在线」。
  const initial = await onlineCount(baseUrl, aliceToken);
  assert(initial.count === 0, '启动后无任何活动时在线人数为 0（/api/online 自身不计活动）');
  assert(
    Array.isArray(initial.items) && initial.items.some((item) => item.username === CAROL),
    '重启后从落盘 lastSeenAt 恢复「刚刚在线」（seed）',
  );

  // 任意 API 请求刷新「最后在线」。
  const before = await lastSeenOf(baseUrl, aliceToken, ALICE);
  await api(baseUrl, aliceToken, 'GET', '/api/feeds?page=1');
  await sleep(1200);
  await api(baseUrl, aliceToken, 'GET', '/api/leaderboard');
  const after = await lastSeenOf(baseUrl, aliceToken, ALICE);
  assert(typeof after === 'number' && (before === null || after > before), 'API 请求刷新「最后在线」时间');

  // 在线人数：Alice（刚才的 API 活动）+ Bob 各计一次；多连接去重。
  await api(baseUrl, bobToken, 'GET', '/api/auth/me');
  let data = await onlineCount(baseUrl, aliceToken);
  assert(data.count === 2, '两个活跃用户在线人数为 2');
  assert(!data.items.some((item) => item.username === ALICE), '在线用户不出现在「刚刚在线」');

  const aliceSocket = await connectSocket(baseUrl, aliceToken, 'Alice');
  data = await onlineCount(baseUrl, aliceToken);
  assert(data.count === 2, '同一用户加开 socket 连接后人数不变（按用户去重）');

  // socket 事件（房间心跳）也算活动：Bob 仅靠 socket 事件维持在线。
  const bobSocket = await connectSocket(baseUrl, bobToken, 'Bob');
  bobSocket.emit('room_heartbeat');
  await sleep(300);
  data = await onlineCount(baseUrl, aliceToken);
  assert(data.count === 2, 'socket 事件刷新活动后人数保持去重计数');

  // bot 连接不计入在线。
  const botSocket = await connectSocket(baseUrl, BOT_TOKEN, 'Bot');
  botSocket.emit('room_heartbeat');
  await sleep(300);
  data = await onlineCount(baseUrl, aliceToken);
  assert(data.count === 2, 'bot 令牌连接不计入在线人数');
  assert(
    (await lastSeenOf(baseUrl, aliceToken, BOT_USER)) === null,
    'bot 连接不刷新其用户名的「最后在线」（合成用户无记录）',
  );

  aliceSocket.disconnect();
  bobSocket.disconnect();
  botSocket.disconnect();
}

async function main() {
  try {
    await runUnitTests();
    log('单元测试全部通过');
    await runIntegrationTests();
    log('集成测试全部通过');
    finish(failures === 0 ? 0 : 1, failures === 0 ? 'presence 测试通过' : `存在 ${failures} 处断言失败`);
  } catch (error) {
    finish(1, `测试失败：${error?.stack ?? error}`);
  }
}

void main();
