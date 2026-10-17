// 真人客户端验证（[AI] 标记）竞态修复回归测试：
// 临时数据目录起 dist 服务 + socket.io-client 真实连接，覆盖
//   1) 真人 JWT 连接按公式算 sig 后发 client_verify（不进房、不等心跳）→
//      进房后房间列表（room_update）该成员不带 ai 标记；
//   2) 不发 sig 的 JWT 连接带 ai 标记，仍正常参战；
//   3) 回归：room_heartbeat 携带 sig 的老路径仍生效；
//   4) bot 令牌连接带 ai；聚焦测试覆盖全 AI 加速与排行榜身份；
//   5) 混合房准备门槛、真实 socket 开局与离开等待房不影响 rating。
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

// 只替换引擎创建边界，直接检查 LobbyService 传入的速度与排行榜回调，避免计时断言。
async function testGameAIClassification(store) {
  const { LobbyService } = await import(
    pathToFileURL(path.join(rootDir, 'dist/server/lobby-service.js')).href
  );
  const { GameEngine } = await import(pathToFileURL(path.join(rootDir, 'dist/game-engine.js')).href);
  const originalCreate = GameEngine.create;
  let captured;
  let duringCreate;
  GameEngine.create = async (conf, _sids, _ids, _gid, callbacks) => {
    captured = { conf, callbacks };
    duringCreate?.(callbacks);
    return { startGame() {} };
  };
  const io = {
    emit() {},
    to() {
      return this;
    },
  };
  try {
    for (const kind of ['unverified', 'human', 'spectator']) {
      const lobby = new LobbyService({}, store);
      // 两个普通 JWT 型成员均无 bot 标志，也必须识别为 AI。
      lobby.joinLobby('ai-a', 'bot_a', 'ai-test');
      lobby.joinLobby('ai-b', 'bot_b', 'ai-test');
      lobby.joinLobby('browser', USER_PLAIN, 'ai-test');
      const players = lobby.lobbyPlayers.get('ai-test');
      if (kind !== 'unverified') lobby.humanVerified.add('browser');
      players[2].team = kind === 'spectator' ? 0 : 1;
      lobby.lobbyConfig.get('ai-test').speed = 2;
      const expected = [true, true, kind === 'unverified', false, false];
      const checkSnapshot = (callbacks) => {
        const entries = [1, 2, 3, 999, 0].map((id) => ({ id, ai: true }));
        callbacks.annotateLeaderboard(entries);
        assert.deepEqual(
          entries.map((entry) => entry.ai),
          expected,
          `${kind}: 开局身份快照与未知席位`,
        );
      };
      duringCreate = (callbacks) => {
        // 引擎工厂尚未返回时即可能发帧，不能依赖稍后赋值的 gameRef。
        checkSnapshot(callbacks);
        lobby.humanVerified.clear();
        lobby.humanVerified.add('ai-a');
        players[0].sid = 'rebound-ai-a';
        players.reverse();
        players.pop();
        checkSnapshot(callbacks);
      };
      await lobby.startGame(io, 'ai-test');
      assert.equal(
        captured.conf.speed,
        kind === 'human' ? 2 : 4,
        '未验证参战者均为 AI；已验证观战者不阻止 4x，真人参战保留配置速度',
      );
      checkSnapshot(captured.callbacks);
    }
    log('场景 5 通过：JWT 全 AI 4x、真人参战 2x、真人观战忽略、开局及换绑/移除后的身份快照稳定');
  } finally {
    GameEngine.create = originalCreate;
  }
}

// 聚焦准备门槛，不替换 checkReady；捕获其真正发出的 startGame 调用。
async function testReadyPolicy(store) {
  const { LobbyService } = await import(
    pathToFileURL(path.join(rootDir, 'dist/server/lobby-service.js')).href
  );
  const io = {
    emit() {},
    to() {
      return this;
    },
  };
  for (const kind of [
    'mixed',
    'pure-bot',
    'spectator',
    'pure-human',
    'majority',
    'mixed-majority',
    'unverified',
  ]) {
    const lobby = new LobbyService({}, store);
    const bot = kind === 'mixed' || kind === 'pure-bot' || kind === 'spectator' || kind === 'mixed-majority';
    lobby.joinLobby('a', 'bot_a', kind, { bot });
    lobby.joinLobby('b', 'bot_b', kind, { bot });
    if (kind !== 'pure-bot') lobby.joinLobby('ordinary', USER_PLAIN, kind);
    if (kind !== 'pure-bot' && kind !== 'unverified') lobby.humanVerified.add('ordinary');
    if (kind === 'pure-human' || kind === 'majority') {
      lobby.humanVerified.add('a');
      lobby.humanVerified.add('b');
    }
    // mixed 中两个 AI 无 bot 标志，验证门槛不能依赖令牌鉴权。
    const players = lobby.lobbyPlayers.get(kind);
    if (kind === 'mixed')
      players.forEach((player) => {
        delete player.bot;
      });
    players.forEach((player) => {
      player.ready = player.sid !== 'ordinary';
    });
    if (kind === 'spectator') players.find((player) => player.sid === 'ordinary').team = 0;
    if (kind === 'majority' || kind === 'mixed-majority') {
      players.forEach((player) => {
        player.ready = false;
      });
      players.find((player) => player.sid === 'ordinary').ready = true;
    }
    let starts = 0;
    lobby.startGame = async () => {
      starts++;
    };
    lobby.checkReady(io, kind);
    assert.equal(
      starts,
      kind === 'mixed' || kind === 'majority' || kind === 'mixed-majority' ? 0 : 1,
      `${kind}: two ready bots must not start around an unready ordinary player; preserve other rules`,
    );
    if (kind === 'mixed') {
      players.find((player) => player.sid === 'ordinary').ready = true;
      lobby.checkReady(io, kind);
      assert.equal(starts, 1, '普通玩家准备后允许开局');
    }
  }
  log('场景 6 通过：混合房普通玩家全员准备 + 原有多数门槛，纯 bot/观战/纯人类规则保持');
}

function waitSocket(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`等待 ${event} 超时`));
    }, 10000);
    function handler(data) {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    }
    socket.on(event, handler);
  });
}

async function testMixedReadySockets(baseUrl, token) {
  const before = (await api(baseUrl, token, '/api/auth/me')).data.rating;
  for (const leaveWaiting of [true, false]) {
    const room = leaveWaiting ? 'guardleave' : 'guardready';
    const { socket: ordinary, setIdPromise } = await connectSocket(baseUrl, token, 'Guard ordinary');
    const id = await setIdPromise;
    let initCount = 0;
    ordinary.on('init_map', () => {
      initCount++;
    });
    const joined = waitRoomUpdateFor(ordinary, id);
    const me = await api(baseUrl, token, '/api/auth/me');
    ordinary.emit('client_verify', { sig: computeSig(me.data.stamp, id) });
    ordinary.emit('join_game_room', { room });
    await joined;
    const bots = [];
    for (const botToken of ['verify-bot-token', 'verify-bot-token-2']) {
      const { socket, setIdPromise: botId } = await connectSocket(baseUrl, botToken, 'Guard bot');
      const entered = waitRoomUpdateFor(socket, await botId);
      socket.emit('join_game_room', { room });
      await entered;
      bots.push(socket);
    }
    // 先等待两个 bot 的准备状态回显，确保服务端确实处理了多数票。
    const readyEcho = waitSocket(
      ordinary,
      'room_update',
      (data) => data.players.filter((player) => player.bot && player.ready).length === 2,
    );
    bots.forEach((socket) => socket.emit('change_ready', { ready: true }));
    await readyEcho;
    await sleep(600);
    assert.equal(initCount, 0, '真实 socket：2 ready bots + unready ordinary player cannot start');
    if (leaveWaiting) {
      const removed = waitSocket(
        bots[0],
        'room_update',
        (data) => !data.players.some((player) => player.sid === id),
      );
      ordinary.disconnect();
      await removed;
      // 超过断线宽限期，排除等待房离开被延后结算为挂机/投降。
      await sleep(11000);
      const after = (await api(baseUrl, token, '/api/auth/me')).data.rating;
      assert.deepEqual(after, before, '离开等待房不改变 rating 或 ratingGames');
      log(
        `场景 7a 通过：真实 socket 离开等待房 rating 前后 ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
      );
    } else {
      const started = waitSocket(ordinary, 'init_map');
      ordinary.emit('change_ready', { ready: true });
      await started;
      assert.equal(initCount, 1, '普通玩家准备后真实开局');
      ordinary.disconnect();
      log('场景 7b 通过：真实 socket 普通玩家准备后开局');
    }
    bots.forEach((socket) => socket.disconnect());
  }
}

async function main() {
  try {
    ensureBuild();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-client-verify-test-'));

    // 直接用编译产物造用户并签发会话 JWT，绕过注册验证码。
    const { UserStore } = await import(pathToFileURL(path.join(rootDir, 'dist', 'auth-store.js')).href);
    const { ensureRuntimeEnv } = await import(
      pathToFileURL(path.join(rootDir, 'dist', 'runtime-env.js')).href
    );
    const store = new UserStore(dataDir);
    await store.ensureReady();
    await store.register(USER_VERIFY, 'verify-pass-1');
    await store.register(USER_PLAIN, 'verify-pass-2');
    await store.register(USER_HEARTBEAT, 'verify-pass-3');
    await store.register('verify_guard', 'verify-pass-guard');
    await testReadyPolicy(store);
    const env = ensureRuntimeEnv();
    const tokens = {};
    for (const username of [USER_VERIFY, USER_PLAIN, USER_HEARTBEAT, 'verify_guard']) {
      const sid = await store.rotateSession(username);
      tokens[username] = jwt.sign({ sub: username, sid }, env.jwtSecret, { expiresIn: '1h' });
    }
    log(`已造用户：${USER_VERIFY} / ${USER_PLAIN} / ${USER_HEARTBEAT}`);

    const port = await findFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [serverEntry, '--port', String(port)], {
      cwd: rootDir,
      env: {
        ...process.env,
        ROKA_DATA_DIR: dataDir,
        ROKA_BOT_TOKENS: 'verify-bot-token:verify_bot,verify-bot-token-2:verify_bot2',
      },
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

    // 场景 2：普通 JWT 连接不发任何 sig，自动识别为 AI。
    const { socket: socketPlain, setIdPromise: plainSetIdPromise } = await connectSocket(
      baseUrl,
      tokens[USER_PLAIN],
      'Plain',
    );
    const plainSetId = await plainSetIdPromise;
    const plainEntryPromise = waitRoomUpdateFor(socketPlain, plainSetId);
    socketPlain.emit('join_game_room', { room: 'verifyroom' });
    const plainEntry = await plainEntryPromise;
    assert.equal(plainEntry.ai, true, '未验证 JWT 连接自动带 ai 标记');
    assert.ok(plainEntry.team > 0, '未验证普通连接仍是参战成员');
    log('场景 2 通过：未验证 JWT 连接带 ai 标记，仍正常参战');

    // 场景 1：client_verify 新路径——连接后拿到 set_id 立即发 sig，再进房。
    const { socket: socketVerify, setIdPromise: verifySetIdPromise } = await connectSocket(
      baseUrl,
      tokens[USER_VERIFY],
      'Verify',
    );
    const verifySetId = await verifySetIdPromise;
    // 不等待 ack、心跳或延时：同一连接紧接着发送 join，断言首次含自己的 room_update。
    socketVerify.on('room_update', (data) => {
      assert.equal(data.players[0].sid, verifySetId, 'client_verify 仍让已验证成员优先成为房主');
    });
    const verifyEntryPromise = waitRoomUpdateFor(socketVerify, verifySetId);
    socketVerify.emit('client_verify', { sig: computeSig(me.data.stamp, verifySetId) });
    socketVerify.emit('join_game_room', { room: 'verifyroom' });
    const verifyEntry = await verifyEntryPromise;
    assert.equal(verifyEntry.ai, undefined, 'client_verify 验证后进房不带 ai 标记');
    log('场景 1 通过：client_verify 新路径验证后房间列表不带 ai 标记');

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
    socketHb.on('room_update', (data) => {
      assert.equal(data.players[1].sid, hbSetId, 'room_heartbeat 验证仍让成员排在未验证成员前');
    });
    const hbEntryPromise = waitRoomUpdateFor(socketHb, hbSetId);
    socketHb.emit('join_game_room', { room: 'verifyroom' });
    const hbEntry = await hbEntryPromise;
    assert.equal(hbEntry.ai, undefined, 'room_heartbeat 携带 sig 验证后进房不带 ai 标记');
    log('场景 3 通过：room_heartbeat 老路径回归仍生效');

    const { socket: socketBot, setIdPromise: botSetIdPromise } = await connectSocket(
      baseUrl,
      'verify-bot-token',
      'Bot',
    );
    const botSetId = await botSetIdPromise;
    const botEntryPromise = waitRoomUpdateFor(socketBot, botSetId);
    socketBot.emit('join_game_room', { room: 'verifyroom' });
    const botEntry = await botEntryPromise;
    assert.equal(botEntry.bot, true, '令牌认证连接被服务端确认为 bot');
    assert.equal(botEntry.ai, true, '已确认 bot 带 ai 标记');
    log('场景 4 通过：bot 令牌认证连接带 ai 标记');

    await testGameAIClassification(store);
    await testMixedReadySockets(baseUrl, tokens.verify_guard);
    finish(0, 'client_verify 测试通过');
  } catch (error) {
    finish(1, `测试失败：${error?.stack ?? error}`);
  }
}

void main();
