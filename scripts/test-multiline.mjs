// 多线争锋冒烟测试（v1.62 起为 v2 语义）：
// 1) 临时数据目录 + 随机端口启动 dist/server.js，注册用户（首个 = 超管）；
// 2) 多线房间：房主 change_game_conf { multi_line: true } 后开局，校验
//    a. init_map 携带 multi_line=true、line_count=1（v2 战线数从 1 条起按需动态增长）；
//    b. 同一点两个不同方向的 attack 自动分兵成两条战线（R4；v2 忽略 attack 携带的
//       line 参数，战线由服务端按起始点路由），两条非空战线真并行：同一 Tick 各执行
//       一条、队列快速排空（不再轮转 1/N）；
//    c. 全新出发点排一条无效操作自成新战线，lst_move 的 skip>=1 且归属该新战线；
// 3) 对照房间：默认配置开局，init_map 不带 multi_line，lst_move 不带 line 字段。
// 4) Bot 房间：第三方 bot 进房后多线被强制关闭，房主再次开启请求被拒绝。
// 5) [AI] 标识：普通未验证连接在 leaderboard/room_update 中不带 ai 标记，
//    上报正确派生值不改变标记；bot 连接恒带 ai 标记。
// 6) 全 AI 房强制 4x 统一判定（已确认 bot 口径）：
//    a. 两个令牌 bot 开局强制 4x（帧率判定；中途进房的人类为观战者不受影响）；
//    b. 未验证的普通 JWT 连接 + 令牌 bot 的混合房不强制 4x；
//    c. 验证真人 + bot 的混编房不强制（按房间速度 1x 走帧）；
//    d. 房主三档优先：bot 独居当房主，验证真人进房后接任房主（players[0] 换人）。
// 7) v3 静态断言：对局页不存在战线区分 UI（battle-line/multi-line-hud 元素、
//    数字键 1-9 / [ ] 切战线绑定、route-line-N 箭头着色类），界面与普通对局一致。
// 成功 exit 0，失败/超时 exit 1。全程硬上限 120 秒。

import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
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
const ROOM_MULTI = 'mlroom';
const ROOM_PLAIN = 'mlplain';
const ROOM_BOT = 'mlbotroom';
const ROOM_ALLBOTS = 'mlallbots';
const ROOM_ALLAI = 'mlallai';
const ROOM_MIXED = 'mlmixed';
const ROOM_HOST = 'mlhost';
const BOT_TOKEN = 'test-token-multiline';
const BOT_TOKEN_2 = 'test-token-multiline-2';

const startedAt = Date.now();
const children = new Set();
const sockets = new Set();
let dataDir = null;
let finished = false;

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[test-multiline ${elapsed}s] ${message}`);
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
  process.exitCode = code;
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
  return { token: jwt.sign({ sub: username, sid }, jwtSecret, { expiresIn: '1h' }), sid };
}

/**
 * 最小对局客户端：进房自动准备；记录 init_map 元数据与逐 Tick 的
 * lst_move（含 line/skip）与 leaderboard 快照供断言。
 */
function createGameClient(baseUrl, { cookie, room, name, autoReady = true, botToken, human }) {
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
    general: [-1, -1],
    initMap: null,
    lstMoves: [], // 逐 Tick 的 lst_move 快照
    leaderboard: [], // 最近一帧 leaderboard
    roomPlayers: [], // 最近一次 room_update.players
    roomMultiLine: undefined,
    roomSpeed: undefined,
    inGame: false,
    frames: 0,
  };

  socket.on('set_id', (id) => {
    client.clientId = String(id || '');
    if (human) {
      // 模拟真实浏览器：进房前先 client_verify 完成真人校验（消除时序竞态）。
      socket.emit('client_verify', { sig: clientSig(human.secret, human.sid, client.clientId) });
      setTimeout(() => socket.emit('join_game_room', { room }), 150);
      return;
    }
    socket.emit('join_game_room', { room });
  });
  socket.on('init_map', (data) => {
    client.initMap = data;
    client.general = data.general;
    client.frames = 0;
    client.lstMoves = [];
  });
  socket.on('update', (data) => {
    client.frames += 1;
    if (data.lst_move) client.lstMoves.push({ ...data.lst_move });
    if (Array.isArray(data.leaderboard)) client.leaderboard = data.leaderboard;
  });
  socket.on('room_update', (data) => {
    if (typeof data?.multi_line !== 'undefined') {
      client.roomMultiLine = Boolean(data.multi_line);
    }
    if (typeof data?.speed !== 'undefined') {
      client.roomSpeed = Number(data.speed);
    }
    if (Array.isArray(data?.players)) {
      client.roomPlayers = data.players;
    }
    client.inGame = Boolean(data?.in_game);
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

// 与前端一致：会话戳 HMAC + 心跳派生值 sha256(stamp:clientId)。
function clientSig(jwtSecret, sessionId, clientId) {
  const stamp = createHmac('sha256', jwtSecret).update(`web:${sessionId}`).digest('hex');
  return createHash('sha256').update(`${stamp}:${clientId}`).digest('hex');
}

async function main() {
  ensureBuild();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-test-multiline-'));
  const port = await findFreePort();
  log(`临时数据目录：${dataDir}，端口：${port}`);

  const { UserStore } = await import(pathToFileURL(path.join(rootDir, 'dist', 'auth-store.js')).href);
  const { ensureRuntimeEnv } = await import(pathToFileURL(path.join(rootDir, 'dist', 'runtime-env.js')).href);
  const store = new UserStore(dataDir);
  await store.ensureReady();
  const env = ensureRuntimeEnv();
  const userA = await signUser(store, env.jwtSecret, 'ml_a', 'ml-pass-1');
  const userB = await signUser(store, env.jwtSecret, 'ml_b', 'ml-pass-2');
  const userC = await signUser(store, env.jwtSecret, 'ml_c', 'ml-pass-3');
  const userD = await signUser(store, env.jwtSecret, 'ml_d', 'ml-pass-4');
  const userE = await signUser(store, env.jwtSecret, 'ml_e', 'ml-pass-5');

  const server = spawn('node', ['--max-old-space-size=1400', serverEntry, '--port', String(port)], {
    cwd: rootDir,
    env: {
      ...process.env,
      ROKA_DATA_DIR: dataDir,
      ROKA_BOT_TOKENS: `${BOT_TOKEN}:bot_ml,${BOT_TOKEN_2}:bot_ml2,test-token-ml-3:bot_mlp,test-token-ml-4:bot_mlq,test-token-ml-5:bot_ml5,test-token-ml-6:bot_ml6,test-token-ml-7:bot_ml7`,
    },
  });
  children.add(server);
  server.stderr.on('data', (chunk) => log(`服务器 stderr: ${String(chunk).trim()}`));

  log('等待服务器就绪……');
  await waitTcpReady(port, SERVER_READY_TIMEOUT_MS);
  const baseUrl = `http://127.0.0.1:${port}`;

  // 场景 1：多线房间
  log('场景 1：开启多线争锋的房间');
  const a = createGameClient(baseUrl, { cookie: userA.token, room: ROOM_MULTI, name: 'A', autoReady: false });
  await waitFor(() => a.clientId !== '', 5000, 'A 进房');
  const b = createGameClient(baseUrl, { cookie: userB.token, room: ROOM_MULTI, name: 'B', autoReady: false });
  await waitFor(() => b.clientId !== '', 5000, 'B 进房');
  await sleep(300);
  a.socket.emit('change_game_conf', { multi_line: true });
  await waitFor(() => a.roomMultiLine === true, 5000, '房间设置同步 multi_line=true');
  log('房间设置已同步：multi_line=true');
  a.socket.emit('change_ready', { ready: true });
  b.socket.emit('change_ready', { ready: true });

  await waitFor(() => a.initMap && b.initMap, 15_000, '多线对局开局');
  if (a.initMap.multi_line !== true || a.initMap.line_count !== 1) {
    throw new Error(
      `多线对局 init_map 缺少 multi_line/line_count：${JSON.stringify({
        multi_line: a.initMap.multi_line,
        line_count: a.initMap.line_count,
      })}`,
    );
  }
  log('init_map 携带 multi_line=true、line_count=1（v2 动态战线从 1 条起）');

  // A 从主城向两个不同方向各排 4 条操作（v2：attack 的 line 参数被忽略，
  // 同出发点多方向自动分兵成两条战线；无效也无妨：调度与 skip 归属照样并行汇报）。
  const [gx, gy] = a.general;
  for (let i = 0; i < 4; i++) {
    a.socket.emit('attack', { x: gx, y: gy, dx: gx + 1, dy: gy, mode: 2 });
    a.socket.emit('attack', { x: gx, y: gy, dx: gx, dy: gy + 1, mode: 2 });
  }
  // 真并行（issue #107）：两条非空战线同一 Tick 各弹一条（执行或丢弃），
  // 各 4 条指令最迟约 5 Tick 同时排空；轮转 1/N 需 8 Tick 才能排空。
  await waitFor(() => a.lstMoves.length >= 10, 20_000, 'lst_move 并行采样');
  const isActive = (mv) => mv.x !== -1 || (mv.skip | 0) > 0;
  const firstAct = a.lstMoves.findIndex(isActive);
  const lastAct = a.lstMoves.map(isActive).lastIndexOf(true);
  if (firstAct === -1) {
    throw new Error('未观察到任何战线活动帧（lst_move 无执行/丢弃记录）');
  }
  if (lastAct - firstAct > 5) {
    throw new Error(`战线排空耗时 ${lastAct - firstAct + 1} Tick，疑似仍为轮转调度（真并行应 ≤6）`);
  }
  log('同点双向操作自动分兵为战线 0/1 并真并行调度（队列 ≤6 Tick 排空）');

  // skip 归属：等既有队列自然耗尽（8 Tick 足够），再从一个全新出发点排一条
  // 无效操作（非邻接，必被丢弃）——自成新战线 2，skip 应归属该战线。
  await sleep(5000);
  for (let i = 0; i < 4; i++) a.socket.emit('pop_queue', {}); // 清理可能残余（v2：全局撤回）
  await sleep(300);
  a.lstMoves = [];
  a.socket.emit('attack', { x: gx + 5, y: gy, dx: gx + 8, dy: gy, mode: 2 });
  await waitFor(
    () => a.lstMoves.some((mv) => mv.skip >= 1 && mv.line === 2),
    10_000,
    '新战线的无效操作被丢弃（skip 归属战线 2）',
  );
  log('skip 丢弃数归属正确的新战线（line=2）');

  // 场景 1b：[AI] 标识——双方开局均未验证，排行榜快照均为 AI；
  // A 在对局中补验只改变房间标记，不改变本局排行榜身份。
  log('场景 1b：对局内 [AI] 身份标识');
  // leaderboard 的 uid 是用户名。
  const lbEntry = (client, username) => client.leaderboard.find((entry) => entry?.uid === username);
  await waitFor(() => lbEntry(a, 'ml_a') && lbEntry(a, 'ml_b'), 5000, 'leaderboard 下发');
  if (lbEntry(a, 'ml_a').ai !== true || lbEntry(a, 'ml_b').ai !== true) {
    throw new Error('未验证 JWT 连接应带 ai 标记');
  }
  log('未验证 JWT 连接的排行榜条目带 ai 标记');
  a.socket.emit('room_heartbeat', { sig: clientSig(env.jwtSecret, userA.sid, a.clientId) });
  const framesBeforeVerify = a.frames;
  await waitFor(() => a.frames > framesBeforeVerify + 2, 10_000, '补验后收到新的排行榜帧');
  if (lbEntry(a, 'ml_a').ai !== true || lbEntry(a, 'ml_b').ai !== true) {
    throw new Error('补验不应改变本局开局身份快照');
  }
  log('上报正确派生值后，排行榜仍保留双方开局时的 AI 标记');
  a.socket.disconnect();
  b.socket.disconnect();

  // 场景 2：对照房间（默认不开多线）
  log('场景 2：默认房间（多线关闭）');
  const c = createGameClient(baseUrl, { cookie: userC.token, room: ROOM_PLAIN, name: 'C' });
  await waitFor(() => c.clientId !== '', 5000, 'C 进房');
  const d = createGameClient(baseUrl, { cookie: userD.token, room: ROOM_PLAIN, name: 'D' });
  await waitFor(() => d.clientId !== '', 5000, 'D 进房');
  await waitFor(() => c.frames >= 3 && d.frames >= 3, 30_000, '单线对局帧下发');
  if (c.initMap.multi_line !== undefined || c.initMap.line_count !== undefined) {
    throw new Error('单线对局不应携带 multi_line/line_count');
  }
  if (c.lstMoves.some((mv) => typeof mv.line !== 'undefined')) {
    throw new Error('单线对局的 lst_move 不应携带 line 字段');
  }
  log('场景 2 通过：单线对局协议不变');
  c.socket.disconnect();
  d.socket.disconnect();

  // 场景 3：Bot 进房强制关闭多线；room_update 的 ai 标记顺带校验。
  log('场景 3：Bot 进房强制关闭多线');
  const e = createGameClient(baseUrl, { cookie: userE.token, room: ROOM_BOT, name: 'E', autoReady: false });
  await waitFor(() => e.clientId !== '', 5000, 'E 进房');
  await sleep(300);
  e.socket.emit('change_game_conf', { multi_line: true });
  await waitFor(() => e.roomMultiLine === true, 5000, '纯人类房间开启多线');
  log('纯人类房间可正常开启多线');
  const bot = createGameClient(baseUrl, {
    botToken: BOT_TOKEN,
    room: ROOM_BOT,
    name: 'BOT',
    autoReady: false,
  });
  await waitFor(() => bot.clientId !== '', 5000, 'Bot 进房');
  await waitFor(() => e.roomMultiLine === false, 5000, 'bot 进房后多线被强制关闭');
  log('bot 进房后多线已强制关闭');
  e.socket.emit('change_game_conf', { multi_line: true });
  await sleep(800);
  if (e.roomMultiLine !== false) {
    throw new Error('房间内有 bot 时房主仍能开启多线');
  }
  // room_update players 的 ai 标记：E 未验证与令牌 bot 均带 ai。
  const eEntry = e.roomPlayers.find((player) => player?.uid === 'ml_e');
  const botEntry = e.roomPlayers.find((player) => player?.uid === 'bot_ml');
  if (!eEntry || eEntry.ai !== true || !botEntry || botEntry.ai !== true) {
    throw new Error(`房间成员列表 ai 标记异常：${JSON.stringify(e.roomPlayers)}`);
  }
  // E 上报正确派生值并触发一次房间状态广播（切换 ready）后，E 不再带 ai 标记。
  e.socket.emit('room_heartbeat', { sig: clientSig(env.jwtSecret, userE.sid, e.clientId) });
  await sleep(300);
  e.socket.emit('change_ready', { ready: true });
  await waitFor(
    () => {
      const entry = e.roomPlayers.find((player) => player?.uid === 'ml_e');
      return entry && entry.ai !== true;
    },
    5000,
    'E 补验后的 room_update 不再带 ai 标记',
  );
  e.socket.emit('change_ready', { ready: false });
  log('场景 3 通过：bot 房无法开启多线；房间成员 ai 标记符合预期');

  // 场景 4：全官方 bot 房强制 4x（两个令牌 bot 自动准备开局，人类中途进房为观战者）。
  log('场景 4：全官方 Bot 房强制 4x 速度');
  const bot1 = createGameClient(baseUrl, { botToken: 'test-token-ml-3', room: ROOM_ALLBOTS, name: 'BOT1' });
  await waitFor(() => bot1.clientId !== '', 5000, 'Bot1 进房');
  const bot2 = createGameClient(baseUrl, { botToken: 'test-token-ml-4', room: ROOM_ALLBOTS, name: 'BOT2' });
  await waitFor(() => bot2.clientId !== '', 5000, 'Bot2 进房');
  // 先等双 bot 对局开始，人类再进房才是观战者（否则占用参赛席位，真人参赛即不强制 4x）。
  await waitFor(() => bot1.initMap && bot2.initMap, 30_000, '双 bot 对局开局');
  const spec = createGameClient(baseUrl, {
    cookie: userC.token,
    room: ROOM_ALLBOTS,
    name: 'SPEC',
    autoReady: false,
  });
  await waitFor(() => spec.initMap, 15_000, '观战者收到 init_map');
  if (spec.general[0] !== -1) {
    throw new Error('对局开始后进房的人类应为观战者（general=[-1,-1]）');
  }
  // 强制 4x 只作用于对局实例（房间设置不变），用帧率判定：4x 每 Tick 125ms。
  // 注意 init_map 下发后还有约 2 秒的开局延迟才真正开始走 Tick，先等真实帧流出。
  await waitFor(() => spec.frames >= 3, 15_000, '观战者收到对局帧');
  spec.frames = 0;
  await sleep(2000);
  if (spec.frames < 10) {
    throw new Error(`全 bot 对局未以 4x 运行：2 秒仅 ${spec.frames} 帧（4x 应约 16 帧）`);
  }
  log(`场景 4 通过：全官方 bot 对局强制 4x（2 秒 ${spec.frames} 帧）`);

  // 场景 5：统一 AI 判定（真人校验口径）与房主三档优先。
  log('场景 5：统一 AI 判定与房主优先级');

  // 5a：令牌 bot 独居时为房主；验证真人进房后接任房主（players[0] 换人）。
  const hostBot = createGameClient(baseUrl, {
    botToken: 'test-token-ml-5',
    room: ROOM_HOST,
    name: 'HOSTBOT',
    autoReady: false,
  });
  await waitFor(() => hostBot.clientId !== '', 5000, 'HostBot 进房');
  await waitFor(() => hostBot.roomPlayers[0]?.uid === 'bot_ml5', 5000, 'bot 独居时为房主');
  const hostHuman = createGameClient(baseUrl, {
    cookie: userE.token,
    room: ROOM_HOST,
    name: 'HOSTHUMAN',
    autoReady: false,
    human: { secret: env.jwtSecret, sid: userE.sid },
  });
  await waitFor(() => hostHuman.clientId !== '', 5000, '验证真人进房');
  await waitFor(() => hostBot.roomPlayers[0]?.uid === 'ml_e', 5000, '真人进房后接任房主（players[0]=ml_e）');
  log('场景 5a 通过：bot 独居当房主，验证真人进房后接任');

  // 5b：未验证普通 JWT 连接 + 令牌 bot 均为 AI，强制 4x。
  const aiUser = createGameClient(baseUrl, { cookie: userB.token, room: ROOM_ALLAI, name: 'AIUSER' });
  await waitFor(() => aiUser.clientId !== '', 5000, '未验证普通连接进房');
  const aiBot = createGameClient(baseUrl, { botToken: 'test-token-ml-6', room: ROOM_ALLAI, name: 'AIBOT' });
  await waitFor(() => aiUser.initMap && aiBot.initMap, 30_000, '未验证普通连接混合房开局');
  await waitFor(() => aiUser.frames >= 3, 15_000, '未验证普通连接混合房帧流出');
  aiUser.frames = 0;
  await sleep(2000);
  if (aiUser.frames < 10) {
    throw new Error(`未验证 JWT 与令牌 bot 的全 AI 房应强制 4x：2 秒 ${aiUser.frames} 帧`);
  }
  log(`场景 5b 通过：未验证 JWT 与令牌 bot 的全 AI 房强制 4x（2 秒 ${aiUser.frames} 帧）`);
  aiUser.socket.disconnect();
  aiBot.socket.disconnect();

  // 5c：验证真人 + bot 的混编房不强制，按房间默认 1x 走帧。
  const mixHuman = createGameClient(baseUrl, {
    cookie: userD.token,
    room: ROOM_MIXED,
    name: 'MIXHUMAN',
    human: { secret: env.jwtSecret, sid: userD.sid },
  });
  await waitFor(() => mixHuman.clientId !== '', 5000, '混编房真人进房');
  const mixBot = createGameClient(baseUrl, { botToken: 'test-token-ml-7', room: ROOM_MIXED, name: 'MIXBOT' });
  await waitFor(() => mixHuman.initMap && mixBot.initMap, 30_000, '混编房开局');
  await waitFor(() => mixHuman.frames >= 2, 15_000, '混编房帧流出');
  mixHuman.frames = 0;
  await sleep(2000);
  if (mixHuman.frames > 9) {
    throw new Error(`混编房不应强制 4x：2 秒 ${mixHuman.frames} 帧（1x 应约 4 帧）`);
  }
  log(`场景 5c 通过：真人混编房不强制 4x（2 秒 ${mixHuman.frames} 帧）`);
  mixHuman.socket.disconnect();
  mixBot.socket.disconnect();
  hostBot.socket.disconnect();
  hostHuman.socket.disconnect();

  // (7) v3 静态断言：客户端不存在任何战线区分 UI（界面与普通对局完全一致）。
  {
    const mustBeAbsent = (content, needle, label) => {
      if (content.includes(needle)) throw new Error(`v3: ${label} 不应残留「${needle}」`);
    };
    const gameHtml = fs.readFileSync(path.join(rootDir, 'static', 'game.html'), 'utf8');
    mustBeAbsent(gameHtml, 'battle-line', 'game.html 战线 tab');
    mustBeAbsent(gameHtml, 'multi-line-hud', 'game.html 战线指示条');
    const mainJs = fs.readFileSync(path.join(rootDir, 'static', 'main.js'), 'utf8');
    mustBeAbsent(mainJs, 'switchLine', 'main.js 战线切换函数');
    if (/key\s*>=\s*'1'\s*&&\s*key\s*<=\s*'9'/.test(mainJs)) {
      throw new Error('v3: main.js 不应残留数字键 1-9 切战线绑定');
    }
    const renderJs = fs.readFileSync(path.join(rootDir, 'static', 'main', 'render-update.js'), 'utf8');
    const mapCss = fs.readFileSync(path.join(rootDir, 'static', 'styles', 'map.css'), 'utf8');
    mustBeAbsent(renderJs, 'route-line-', 'render-update.js 按战线着色类');
    mustBeAbsent(mapCss, 'route-line-', 'map.css 战线着色规则');
    log('场景 5 通过：v3 静态断言（无 battle-line UI、无数字键切战线绑定、无按战线着色）');
  }

  finish(0, '测试通过：多线调度、单线兼容、bot 房禁用、[AI] 标识、全 bot 4x 与 v3 无战线 UI 均符合预期');
}

main().catch((error) => finish(1, `测试异常：${error.stack || error.message}`));
