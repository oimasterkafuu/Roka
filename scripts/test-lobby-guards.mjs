// 回归测试：issue「服务端托管 Bot 有时卡着不动」根因修复。
// 场景 1（turn-1 终局）：组队模式下所有参赛者同一队伍时服务端应拒绝开局
//   （修复前：开局即首 Tick 终局，反复空转）。
// 场景 2（同名换绑冲突）：对局中同名人类连接进房不得接管 bot 令牌连接的席位
//   （修复前：tryRejoin 按用户名误换绑，bot 收不到 update 而卡死）；
//   同时校验 bot 自身断线重连与同名人类正常断线重连仍可换绑恢复。
// 场景 3（大地图选项）：房主 change_game_conf {map_size:'large'} 后开局的
//   地图面积应约为同人数、同种子标准地图的 4 倍。
// 场景 4（只剩 bot 重置房间设置）：准备阶段人类全部离开（观战席人类仍算
//   人类占用）、房间只剩 bot 时设置重置为默认值；对局进行中人类离开不触发，
//   对局结束回到准备阶段后才重置。
// 成功 exit 0，失败/超时 exit 1。全程硬上限 120 秒。

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

const HARD_TIMEOUT_MS = 120_000;
const SERVER_READY_TIMEOUT_MS = 20_000;
const ROOM_TEAM = 'guardteam';
const ROOM_DUP = 'guarddup';
const ROOM_SIZE_NORMAL = 'gsznorm';
const ROOM_SIZE_LARGE = 'gszbig';
const ROOM_RESET = 'guardrst';
const ROOM_RESET_GAME = 'guardrstg';
const MAP_RESET_TOKEN = 'guard-reset-token';
const MAP_SIZE_TOKEN = 'guard-size-token';
const DUP_USER = 'guard_dup';
const USER_A = 'guard_a';
const USER_B = 'guard_b';
const BOT_TOKEN = 'guard-bot-token';

const startedAt = Date.now();
const children = new Set();
const sockets = new Set();
let dataDir = null;
let finished = false;

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[test-lobby-guards ${elapsed}s] ${message}`);
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

async function prepareUsers(dir) {
  const { UserStore } = await import(pathToFileURL(path.join(rootDir, 'dist', 'auth-store.js')).href);
  const { ensureRuntimeEnv } = await import(pathToFileURL(path.join(rootDir, 'dist', 'runtime-env.js')).href);
  const store = new UserStore(dir);
  await store.ensureReady();
  const env = ensureRuntimeEnv();
  const sign = async (username, password) => {
    await store.register(username, password);
    const sid = await store.rotateSession(username);
    return jwt.sign({ sub: username, sid }, env.jwtSecret, { expiresIn: '1h' });
  };
  return {
    dupToken: await sign(DUP_USER, 'guard-pass-1'),
    tokenA: await sign(USER_A, 'guard-pass-2'),
    tokenB: await sign(USER_B, 'guard-pass-3'),
  };
}

/**
 * 最小房间客户端：connect 后进房，room_update 中发现自己未准备则准备。
 * 暴露收到的 init_map / update / chat_message 供断言。
 */
function createRoomClient(baseUrl, { cookie, token, room, autoReady = true, name }) {
  const socket = ioClient(baseUrl, {
    transports: ['websocket', 'polling'],
    auth: token ? { token } : undefined,
    extraHeaders: cookie ? { cookie: `auth_token=${encodeURIComponent(cookie)}` } : undefined,
    reconnection: false,
  });
  sockets.add(socket);

  const client = {
    socket,
    name,
    clientId: '',
    inits: [],
    updates: 0,
    chats: [],
    kicks: 0,
    roomUpdates: [],
  };

  socket.on('set_id', (id) => {
    client.clientId = String(id || '');
    socket.emit('join_game_room', { room });
  });
  socket.on('init_map', (data) => {
    client.inits.push(data);
  });
  socket.on('update', () => {
    client.updates += 1;
  });
  socket.on('chat_message', (data) => {
    client.chats.push(String(data?.text ?? ''));
  });
  socket.on('room_kick', () => {
    client.kicks += 1;
  });
  socket.on('room_update', (data) => {
    client.roomUpdates.push(data);
    if (!autoReady || !client.clientId || !Array.isArray(data?.players) || data?.in_game) {
      return;
    }
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

async function scenarioSameTeam(baseUrl, tokenA, tokenB) {
  log('场景 1：组队模式全员同队应拒绝开局');
  const a = createRoomClient(baseUrl, { cookie: tokenA, room: ROOM_TEAM, autoReady: false, name: 'A' });
  await waitFor(() => a.clientId !== '', 5000, 'A 进房');
  const b = createRoomClient(baseUrl, { cookie: tokenB, room: ROOM_TEAM, autoReady: false, name: 'B' });
  await waitFor(() => b.clientId !== '', 5000, 'B 进房');

  // A 是房主：开启组队模式（两队成员此前在 FFA 规则下都被归为 team 1，开启后保持 team 1）。
  a.socket.emit('change_game_conf', { allow_team: true });
  await sleep(500);
  a.socket.emit('change_ready', { ready: true });
  b.socket.emit('change_ready', { ready: true });
  // 双方均已准备；等待足够长时间确认不会开局。
  await sleep(4000);
  if (a.inits.length > 0 || b.inits.length > 0) {
    throw new Error('全员同队时仍然开局（收到 init_map），修复无效');
  }
  if (!a.chats.some((text) => text.includes('同一队伍'))) {
    throw new Error('未收到「同一队伍」提示消息');
  }
  log('场景 1a 通过：全员同队未开局且收到提示');

  // B 换到队伍 2 后应能正常开局。
  b.socket.emit('change_team', { team: 2 });
  await sleep(300);
  a.socket.emit('change_ready', { ready: true });
  b.socket.emit('change_ready', { ready: true });
  await waitFor(() => a.inits.length > 0 && b.inits.length > 0, 8000, '换队后开局');
  log('场景 1b 通过：调整为不同队伍后正常开局');
  a.socket.disconnect();
  b.socket.disconnect();
}

async function scenarioDuplicateName(baseUrl, dupToken, tokenB) {
  log('场景 2：同名人类连接不得接管 bot 席位');
  // bot 令牌连接（用户名 guard_dup）与人类 guard_b 开局。
  const bot = createRoomClient(baseUrl, { token: BOT_TOKEN, room: ROOM_DUP, name: 'bot' });
  await waitFor(() => bot.clientId !== '', 5000, 'bot 进房');
  const humanB = createRoomClient(baseUrl, { cookie: tokenB, room: ROOM_DUP, name: 'B' });
  await waitFor(() => humanB.clientId !== '', 5000, 'B 进房');
  await waitFor(() => bot.inits.length > 0 && humanB.inits.length > 0, 10_000, '双人对局开局');
  const botGeneral = bot.inits[0]?.general;
  if (!Array.isArray(botGeneral) || botGeneral[0] < 0) {
    throw new Error('bot 未以参赛身份收到 init_map');
  }
  log('对局已开始，bot 为参赛玩家');

  // 同名人类（guard_dup 的浏览器连接）在对局进行中进房：不得抢走 bot 的席位。
  await waitFor(() => bot.updates > 0, 5000, 'bot 收到 update');
  const humanDup = createRoomClient(baseUrl, { cookie: dupToken, room: ROOM_DUP, name: 'human-dup' });
  await waitFor(() => humanDup.clientId !== '', 5000, '同名人类进房');
  await sleep(1000);
  const dupInit = humanDup.inits[humanDup.inits.length - 1];
  if (!dupInit || !Array.isArray(dupInit.general) || dupInit.general[0] >= 0) {
    throw new Error('同名人类未以观战身份收到 init_map（疑似接管了 bot 席位）');
  }
  const updatesAtJoin = bot.updates;
  await sleep(2500);
  if (bot.updates <= updatesAtJoin) {
    throw new Error('同名人类进房后 bot 停止收到 update（席位被换绑）');
  }
  log('场景 2a 通过：同名人类以观战身份进房，bot 持续收到 update');
  humanDup.socket.disconnect();

  // bot 自身断线重连：同身份换绑仍应恢复参赛席位。
  const oldBotSocket = bot.socket;
  const botClientId = bot.clientId;
  oldBotSocket.disconnect();
  await sleep(800);
  const bot2 = createRoomClient(baseUrl, { token: BOT_TOKEN, room: ROOM_DUP, name: 'bot-rejoin' });
  await waitFor(() => bot2.inits.length > 0, 8000, 'bot 重连补发 init_map');
  const rejoinInit = bot2.inits[bot2.inits.length - 1];
  if (!Array.isArray(rejoinInit.general) || rejoinInit.general[0] < 0) {
    throw new Error('bot 断线重连未能恢复参赛席位');
  }
  log(`场景 2b 通过：bot 断线重连恢复席位（旧 clientId=${botClientId.slice(0, 8)}…）`);

  // 同名人类正常断线重连（对局中 B 顶号/刷新）仍应换绑恢复。
  humanB.socket.disconnect();
  await sleep(800);
  const humanB2 = createRoomClient(baseUrl, { cookie: tokenB, room: ROOM_DUP, name: 'B-rejoin' });
  await waitFor(() => humanB2.inits.length > 0, 8000, '人类 B 重连补发 init_map');
  const rejoinInitB = humanB2.inits[humanB2.inits.length - 1];
  if (!Array.isArray(rejoinInitB.general) || rejoinInitB.general[0] < 0) {
    throw new Error('人类断线重连未能恢复参赛席位');
  }
  log('场景 2c 通过：人类断线重连恢复席位');
  bot2.socket.disconnect();
  humanB2.socket.disconnect();
}

async function scenarioMapSize(baseUrl, tokenA, tokenB) {
  log('场景 3：大地图选项使用 MAX_TEAMS 基础比例并放大');
  // 同人数（2 人）、同种子开两局：标准按人数缩放，大地图按 MAX_TEAMS 基础比例再乘 2。
  const normalA = createRoomClient(baseUrl, {
    cookie: tokenA,
    room: ROOM_SIZE_NORMAL,
    autoReady: false,
    name: 'N-A',
  });
  await waitFor(() => normalA.clientId !== '', 5000, '标准房 A 进房');
  const normalB = createRoomClient(baseUrl, {
    cookie: tokenB,
    room: ROOM_SIZE_NORMAL,
    autoReady: false,
    name: 'N-B',
  });
  await waitFor(() => normalB.clientId !== '', 5000, '标准房 B 进房');
  normalA.socket.emit('change_game_conf', { map_token: MAP_SIZE_TOKEN });
  normalA.socket.emit('change_ready', { ready: true });
  normalB.socket.emit('change_ready', { ready: true });
  await waitFor(() => normalA.inits.length > 0 && normalB.inits.length > 0, 8000, '标准房开局');

  const largeA = createRoomClient(baseUrl, {
    cookie: tokenA,
    room: ROOM_SIZE_LARGE,
    autoReady: false,
    name: 'L-A',
  });
  await waitFor(() => largeA.clientId !== '', 5000, '大地图房 A 进房');
  const largeB = createRoomClient(baseUrl, {
    cookie: tokenB,
    room: ROOM_SIZE_LARGE,
    autoReady: false,
    name: 'L-B',
  });
  await waitFor(() => largeB.clientId !== '', 5000, '大地图房 B 进房');
  largeA.socket.emit('change_game_conf', { map_size: 'large', map_token: MAP_SIZE_TOKEN });
  largeA.socket.emit('change_ready', { ready: true });
  largeB.socket.emit('change_ready', { ready: true });
  await waitFor(() => largeA.inits.length > 0 && largeB.inits.length > 0, 8000, '大地图房开局');

  const normalInit = normalA.inits[0];
  const largeInit = largeA.inits[0];
  const normalArea = normalInit.n * normalInit.m;
  const largeArea = largeInit.n * largeInit.m;
  const ratio = largeArea / normalArea;
  log(
    `标准图 ${normalInit.n}x${normalInit.m}=${normalArea}，大地图 ${largeInit.n}x${largeInit.m}=${largeArea}，面积比 ${ratio.toFixed(2)}`,
  );
  if (!(ratio >= 35 && ratio <= 70)) {
    throw new Error(`大地图面积比 ${ratio.toFixed(2)} 不在预期范围 [35, 70] 内`);
  }
  log('场景 3 通过：大地图使用最大基础比例并放大 2 倍');
  for (const client of [normalA, normalB, largeA, largeB]) {
    client.socket.disconnect();
  }
}

function lastRoomUpdate(client) {
  return client.roomUpdates[client.roomUpdates.length - 1];
}

async function scenarioResetWhenOnlyBots(baseUrl, tokenA, tokenB) {
  log('场景 4：只剩 bot 时房间设置重置为默认值');
  // 人类先进房占据房主位（第三方 bot 令牌先进房时房主是 bot，
  // 只有服务端托管 bot 才永远排在普通成员之后）。
  const a = createRoomClient(baseUrl, { cookie: tokenA, room: ROOM_RESET, autoReady: false, name: 'rst-A' });
  await waitFor(() => a.clientId !== '', 5000, 'A 进房');
  const bot = createRoomClient(baseUrl, {
    token: BOT_TOKEN,
    room: ROOM_RESET,
    autoReady: false,
    name: 'rst-bot',
  });
  await waitFor(() => bot.clientId !== '', 5000, 'bot 进房');

  // A 是房主：改一组非默认设置（bot 房迷雾强制关闭，不在此列）。
  a.socket.emit('change_game_conf', {
    speed: 2,
    allow_team: true,
    map_mode: 'maze',
    map_size: 'large',
    map_token: MAP_RESET_TOKEN,
  });
  await waitFor(
    () => {
      const update = lastRoomUpdate(a);
      return update && update.speed === 2 && update.map_mode === 'maze' && update.map_size === 'large';
    },
    5000,
    '自定义设置生效',
  );
  log('自定义设置已生效（speed=2 / maze / large / allow_team）');

  // 边界：观战席的人类仍算人类占用——A 离开后 B 还在，不触发重置。
  const b = createRoomClient(baseUrl, { cookie: tokenB, room: ROOM_RESET, autoReady: false, name: 'rst-B' });
  await waitFor(() => b.clientId !== '', 5000, 'B 进房');
  b.socket.emit('change_team', { team: 0 });
  await waitFor(
    () => {
      const update = lastRoomUpdate(b);
      const self = update?.players?.find((player) => String(player?.sid || '') === b.clientId);
      return self && Number(self.team) === 0;
    },
    5000,
    'B 切换到观战席',
  );
  a.socket.disconnect();
  await sleep(1000);
  const afterHostLeft = lastRoomUpdate(bot);
  if (!afterHostLeft || afterHostLeft.speed !== 2 || afterHostLeft.map_mode !== 'maze') {
    throw new Error('房主离开但观战人类仍在时设置被重置（应保留自定义设置）');
  }
  log('场景 4a 通过：观战人类仍在房时不触发重置');

  // B 也离开：房间只剩 bot，设置应重置为新建房间默认值。
  b.socket.disconnect();
  await waitFor(
    () => {
      const update = lastRoomUpdate(bot);
      return update && update.speed === 1 && update.players?.length === 1;
    },
    5000,
    '只剩 bot 后设置重置',
  );
  const reset = lastRoomUpdate(bot);
  if (
    reset.map_mode !== 'random' ||
    reset.map_size !== 'normal' ||
    reset.allow_team !== false ||
    reset.fog !== false ||
    reset.map_token === MAP_RESET_TOKEN
  ) {
    throw new Error(`重置后的设置不是默认值：${JSON.stringify(reset)}`);
  }
  if (reset.players[0]?.bot !== true) {
    throw new Error('重置后房间内应只剩 bot 成员');
  }
  log('场景 4b 通过：只剩 bot 时设置重置为默认值（含重新随机种子）');
  bot.socket.disconnect();
}

async function scenarioNoResetDuringGame(baseUrl, tokenA) {
  log('场景 5：对局进行中人类离开不触发重置，对局结束后才重置');
  const a = createRoomClient(baseUrl, {
    cookie: tokenA,
    room: ROOM_RESET_GAME,
    autoReady: false,
    name: 'rstg-A',
  });
  await waitFor(() => a.clientId !== '', 5000, 'A 进房');
  const bot = createRoomClient(baseUrl, { token: BOT_TOKEN, room: ROOM_RESET_GAME, name: 'rstg-bot' });
  await waitFor(() => bot.clientId !== '', 5000, 'bot 进房');

  a.socket.emit('change_game_conf', { speed: 2, map_mode: 'maze' });
  await waitFor(
    () => {
      const update = lastRoomUpdate(a);
      return update && update.speed === 2 && update.map_mode === 'maze';
    },
    5000,
    '自定义设置生效',
  );
  a.socket.emit('change_ready', { ready: true });
  await waitFor(() => bot.inits.length > 0 && a.inits.length > 0, 10_000, '双人对局开局');

  // 对局进行中人类断开：走 10 秒宽限期，期间不触发重置（对局中本来就不会有
  // 人员移出；宽限到期移出成员时 resetLobbyConfigIfOnlyBots 也会因对局未结束而跳过）。
  a.socket.disconnect();
  await sleep(2000);
  const duringGame = lastRoomUpdate(bot);
  if (!duringGame || duringGame.speed !== 2 || duringGame.map_mode !== 'maze') {
    throw new Error('对局进行中人类离开后设置被重置（应保持不变）');
  }
  log('场景 5a 通过：对局进行中不触发重置');

  // 人类宽限期到期按挂机投降后 bot 获胜，对局结束回到准备阶段：
  // 房间只剩 bot，此时设置应被重置。
  await waitFor(
    () => {
      const update = lastRoomUpdate(bot);
      return update && update.in_game === false && update.speed === 1 && update.players?.length === 1;
    },
    30_000,
    '对局结束后设置重置',
  );
  const ended = lastRoomUpdate(bot);
  if (ended.map_mode !== 'random') {
    throw new Error(`对局结束后重置不彻底：${JSON.stringify(ended)}`);
  }
  log('场景 5b 通过：对局结束回到准备阶段后设置重置为默认值');
  bot.socket.disconnect();
}

async function main() {
  ensureBuild();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-test-lobby-guards-'));
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`临时数据目录：${dataDir}，端口：${port}`);

  const { dupToken, tokenA, tokenB } = await prepareUsers(dataDir);

  const server = spawn(process.execPath, [serverEntry, '--port', String(port)], {
    cwd: rootDir,
    env: {
      ...process.env,
      ROKA_DATA_DIR: dataDir,
      ROKA_BOT_TOKENS: `${BOT_TOKEN}:${DUP_USER}`,
    },
  });
  children.add(server);
  server.stderr.on('data', (chunk) => log(`服务器 stderr: ${String(chunk).trim()}`));

  await waitTcpReady(port, SERVER_READY_TIMEOUT_MS);
  log('服务器已就绪');

  await scenarioSameTeam(baseUrl, tokenA, tokenB);
  await scenarioDuplicateName(baseUrl, dupToken, tokenB);
  await scenarioMapSize(baseUrl, tokenA, tokenB);
  await scenarioResetWhenOnlyBots(baseUrl, tokenA, tokenB);
  await scenarioNoResetDuringGame(baseUrl, tokenA);

  finish(0, '全部回归场景通过');
}

main().catch((error) => finish(1, `测试失败：${error.stack || error.message}`));
