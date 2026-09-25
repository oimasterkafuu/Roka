// Roka 服务端托管策略 Bot 冒烟测试（issue #18 + 多模板/组队选项扩展）：
// 1) 临时数据目录 + dist/auth-store.js 直接造用户（首个用户 = 超级管理员）；
// 2) 启动 dist/server.js（ROKA_BOT_TOKENS 注入一个第三方 bot 合成用户）；
// 3) 以超管身份调 POST /api/admin/bots/start 在服务器进程内启动托管 Bot；
// 4) 校验：普通用户访问 bot API 被 403；GET /api/admin/bot-templates 自动发现
//    simple-strategy-bot 与 anti-human-bot；
// 5) simple-strategy-bot：进房后 host 不是 bot（第三方 bot 进房后接任房主）；
// 6) anti-human-bot：启动即自动准备进入对局；同一房间启动第二个 bot 返回 409；
//    allowTeam=true 的房间允许房主自由开关组队；
// 7) allowTeam=false 校验（独立房间）：bot 进房强制关闭已开组队 + 房主开启请求被拒绝；
// 8) 启动 random-patch-bot 作为对手触发开局，解析服务器 stdout 中 [server-bot] 日志，
//    要求收到 init_map 且发出 >=5 条实际 attack 操作；
// 9) 重启恢复（issue #28）：不停止 bot 直接杀掉服务器，校验状态文件已记录运行中 bot
//    （含 template/allowTeam）；同数据目录重启后 bot 应以相同用户名/房间号/模板/组队配置
//    自动恢复并连上；
// 10) 调 POST /api/admin/bots/stop 停止并确认列表清空、状态文件已清除。
// 成功 exit 0，失败/超时 exit 1。全程硬上限 180 秒。

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
const randomBotDir = path.join(rootDir, 'bot-template', 'random-patch-bot');

const HARD_TIMEOUT_MS = 180_000;
const SERVER_READY_TIMEOUT_MS = 20_000;
const GAME_TIMEOUT_MS = 60_000;
const REQUIRED_ATTACKS = 5;
const ROOM = 'smokeroom';
const GUARD_ROOM = 'guardroom';
const ANTI_ROOM = 'antihumant';
const ADMIN_USER = 'smoke_admin';
const BOT_USER = 'smoke_bot';
const BOT_USER_2 = 'smoke_bot2';
const NORMAL_USER = 'smoke_user';
const ANTI_USER = 'smoke_anti';
const RANDOM_BOT_USER = 'smoke_rand';

const startedAt = Date.now();
const children = new Set();
let dataDir = null;
let finished = false;

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[test-server-bot ${elapsed}s] ${message}`);
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

function ensureBuild() {
  if (fs.existsSync(serverEntry)) {
    return;
  }
  log('dist/server.js 不存在，先执行 pnpm run build');
  const result = spawnSync('pnpm', ['run', 'build'], { cwd: rootDir, stdio: 'inherit' });
  if (result.status !== 0 || !fs.existsSync(serverEntry)) {
    throw new Error('构建失败，无法启动服务器');
  }
}

function spawnLogged(name, command, args, options) {
  const child = spawn(command, args, options);
  children.add(child);
  child.on('exit', (code, signal) => {
    log(`${name} 退出：code=${code} signal=${signal}`);
  });
  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 等待 socket 上满足条件的下一条 room_update；超时视为失败。
function waitRoomUpdate(socket, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room_update', handler);
      reject(new Error(`等待「${label}」超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);
    const handler = (data) => {
      if (predicate(data)) {
        clearTimeout(timer);
        socket.off('room_update', handler);
        resolve(data);
      }
    };
    socket.on('room_update', handler);
  });
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

async function prepareUsers(dir) {
  // 直接用编译产物造用户，绕过注册验证码（超管 = 首个注册用户）。
  const { UserStore } = await import(pathToFileURL(path.join(rootDir, 'dist', 'auth-store.js')).href);
  const { ensureRuntimeEnv } = await import(
    pathToFileURL(path.join(rootDir, 'dist', 'runtime-env.js')).href
  );
  const store = new UserStore(dir);
  await store.ensureReady();
  await store.register(ADMIN_USER, 'smoke-pass-1');
  await store.register(BOT_USER, 'smoke-pass-2');
  await store.register(BOT_USER_2, 'smoke-pass-4');
  await store.register(NORMAL_USER, 'smoke-pass-3');
  await store.register(ANTI_USER, 'smoke-pass-5');
  const adminSid = await store.rotateSession(ADMIN_USER);
  const userSid = await store.rotateSession(NORMAL_USER);
  const env = ensureRuntimeEnv();
  return {
    adminToken: jwt.sign({ sub: ADMIN_USER, sid: adminSid }, env.jwtSecret, { expiresIn: '1h' }),
    userToken: jwt.sign({ sub: NORMAL_USER, sid: userSid }, env.jwtSecret, { expiresIn: '1h' }),
  };
}

async function waitRoomHost(baseUrl, adminToken, expectedHost, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { status, data } = await api(baseUrl, adminToken, 'GET', '/api/rooms');
    if (status === 200 && Array.isArray(data)) {
      const room = data.find((item) => item.room === ROOM);
      if (room) {
        if (room.host === expectedHost) {
          return room;
        }
      }
    }
    await sleep(500);
  }
  return null;
}

async function main() {
  ensureBuild();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-test-server-bot-'));
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`临时数据目录：${dataDir}，端口：${port}`);

  const { adminToken, userToken } = await prepareUsers(dataDir);
  log('已造用户：smoke_admin（超管）/ smoke_bot、smoke_bot2、smoke_anti（bot 账号）/ smoke_user（普通用户）');

  const serverEnv = {
    ...process.env,
    ROKA_DATA_DIR: dataDir,
    ROKA_BOT_TOKENS: `smoke-token:${RANDOM_BOT_USER}`,
  };
  const spawnServer = (name) => {
    const child = spawnLogged(name, process.execPath, [serverEntry, '--port', String(port)], {
      cwd: rootDir,
      env: serverEnv,
    });
    child.stderr.on('data', (chunk) => log(`服务器 stderr: ${String(chunk).trim()}`));
    return child;
  };
  const server = spawnServer('服务器');

  let sawInitMap = false;
  let sawAntiInitMap = false;
  let attackCount = 0;
  let serverBuffer = '';
  server.stdout.on('data', (chunk) => {
    serverBuffer += chunk;
    const lines = serverBuffer.split('\n');
    serverBuffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.includes('[server-bot]')) {
        continue;
      }
      console.log(`    服务器 | ${trimmed}`);
      if (trimmed.includes('init_map')) {
        sawInitMap = true;
      }
      if (trimmed.includes('[对局] 初始化')) {
        sawAntiInitMap = true;
      }
      if (/\[server-bot\] .*: turn \d+: attack /.test(trimmed)) {
        attackCount += 1;
      }
    }
  });

  log('等待服务器就绪……');
  await waitTcpReady(port, SERVER_READY_TIMEOUT_MS);
  log('服务器已就绪');

  // 普通用户（非管理员）访问 bot API 应被 403 拒绝。
  const forbidden = await api(baseUrl, userToken, 'GET', '/api/admin/bots');
  if (forbidden.status !== 403) {
    return finish(1, `权限校验失败：普通用户 GET /api/admin/bots 返回 ${forbidden.status}（期望 403）`);
  }
  const forbiddenTemplates = await api(baseUrl, userToken, 'GET', '/api/admin/bot-templates');
  if (forbiddenTemplates.status !== 403) {
    return finish(
      1,
      `权限校验失败：普通用户 GET /api/admin/bot-templates 返回 ${forbiddenTemplates.status}（期望 403）`,
    );
  }
  log('普通用户访问 /api/admin/bots 与 /api/admin/bot-templates 被 403 拒绝（符合预期）');

  // 模板枚举校验：应自动发现 simple-strategy-bot 与 anti-human-bot，且不包含 CLI 参考模板。
  const templates = await api(baseUrl, adminToken, 'GET', '/api/admin/bot-templates');
  const templateIds = Array.isArray(templates.data?.items) ? templates.data.items.map((item) => item.id) : [];
  if (templates.status !== 200 || !templateIds.includes('simple-strategy-bot') || !templateIds.includes('anti-human-bot')) {
    return finish(1, `模板枚举校验失败：HTTP ${templates.status} items=${JSON.stringify(templateIds)}`);
  }
  if (templateIds.includes('random-patch-bot')) {
    return finish(1, `模板枚举校验失败：CLI 参考模板 random-patch-bot 不应可托管（items=${JSON.stringify(templateIds)}）`);
  }
  log(`模板枚举校验通过：可托管模板 ${JSON.stringify(templateIds)}`);

  // 超管启动服务端托管策略 Bot。
  const started = await api(baseUrl, adminToken, 'POST', '/api/admin/bots/start', {
    username: BOT_USER,
    room: ROOM,
    template: 'simple-strategy-bot',
    allowTeam: false,
  });
  if (started.status !== 200 || !started.data?.bot?.id) {
    return finish(1, `启动 bot 失败：HTTP ${started.status} ${JSON.stringify(started.data)}`);
  }
  if (started.data.bot.template !== 'simple-strategy-bot' || started.data.bot.allowTeam !== false) {
    return finish(1, `启动 bot 失败：返回记录缺少 template/allowTeam ${JSON.stringify(started.data.bot)}`);
  }
  const botId = started.data.bot.id;
  log(`策略 Bot 已启动：id=${botId}（模板 simple-strategy-bot，不允许组队）`);

  // bot 单独在房时暂居首位；第三方 bot 进房后应立即接任房主。
  const randomBot = spawnLogged('random-bot', process.execPath, [path.join(randomBotDir, 'index.js')], {
    cwd: randomBotDir,
    env: {
      ...process.env,
      BOT_SERVER: baseUrl,
      BOT_ROOM: ROOM,
      BOT_TOKEN: 'smoke-token',
      BOT_AUTO_READY: '1',
    },
  });
  randomBot.stderr.on('data', (chunk) => log(`random-bot stderr: ${String(chunk).trim()}`));

  const roomAfterJoin = await waitRoomHost(baseUrl, adminToken, RANDOM_BOT_USER, 20_000);
  if (!roomAfterJoin) {
    return finish(1, '房长保留校验失败：第三方 bot 进房后 host 未切换为 smoke_rand');
  }
  log(`房长保留校验通过：host=${roomAfterJoin.host}（服务端托管 bot 未当房主）`);

  // anti-human-bot 校验：
  // 1) 启动（allowTeam=true）后 bot 独占房间即为房主，房间允许组队；
  // 2) 同一房间再启动第二个 bot 应 409；
  // 3) 普通用户进房后 bot 自动准备（无需 /ready 聊天命令），房主可自由开关组队；
  // 4) 房主准备后触发开局，bot 自动进入对局（stdout 出现 [对局] 初始化）。
  const { io: ioClient } = require('socket.io-client');
  const antiStarted = await api(baseUrl, adminToken, 'POST', '/api/admin/bots/start', {
    username: ANTI_USER,
    room: ANTI_ROOM,
    template: 'anti-human-bot',
    allowTeam: true,
  });
  if (antiStarted.status !== 200 || !antiStarted.data?.bot?.id) {
    return finish(1, `anti-human 校验失败：启动 bot 出错（HTTP ${antiStarted.status} ${JSON.stringify(antiStarted.data)}）`);
  }
  if (antiStarted.data.bot.template !== 'anti-human-bot' || antiStarted.data.bot.allowTeam !== true) {
    return finish(1, `anti-human 校验失败：返回记录 template/allowTeam 不符 ${JSON.stringify(antiStarted.data.bot)}`);
  }
  const antiBotId = antiStarted.data.bot.id;
  log(`anti-human Bot 已启动：id=${antiBotId}（允许组队）`);

  const antiDup = await api(baseUrl, adminToken, 'POST', '/api/admin/bots/start', {
    username: BOT_USER_2,
    room: ANTI_ROOM,
    template: 'anti-human-bot',
    allowTeam: false,
  });
  if (antiDup.status !== 409) {
    return finish(1, `anti-human 校验失败：同一房间启动第二个 bot 返回 ${antiDup.status}（期望 409）`);
  }
  log('anti-human 校验通过：同一房间启动第二个 bot 被 409 拒绝');

  const badTpl = await api(baseUrl, adminToken, 'POST', '/api/admin/bots/start', {
    username: BOT_USER_2,
    room: 'othertplroom',
    template: 'random-patch-bot',
    allowTeam: false,
  });
  if (badTpl.status !== 400) {
    return finish(1, `anti-human 校验失败：不可托管模板启动返回 ${badTpl.status}（期望 400）`);
  }
  log('anti-human 校验通过：不可托管模板 random-patch-bot 被 400 拒绝');

  const antiSocket = ioClient(baseUrl, {
    auth: { token: userToken },
    transports: ['websocket'],
  });
  await new Promise((resolve, reject) => {
    antiSocket.once('connect', resolve);
    antiSocket.once('connect_error', reject);
  });
  try {
    antiSocket.emit('join_game_room', { room: ANTI_ROOM });
    await waitRoomUpdate(
      antiSocket,
      (d) =>
        d.allow_team === true &&
        d.players.length === 2 &&
        d.players.some((p) => p.uid === ANTI_USER && p.server_bot === true),
      15_000,
      'anti-human bot 独占房间允许组队',
    );
    log('anti-human 校验通过：allowTeam=true 的 bot 独占房间时房间允许组队');

    await waitRoomUpdate(
      antiSocket,
      (d) => d.players.find((p) => p.uid === ANTI_USER)?.ready === true,
      20_000,
      'anti-human bot 自动准备',
    );
    log('anti-human 校验通过：bot 无需聊天命令即自动准备');

    // 房主（普通用户）关闭再开启组队均不应被拒绝（allowTeam=true 的托管 bot 房间不受限）。
    const teamOff = waitRoomUpdate(antiSocket, (d) => d.allow_team === false, 10_000, 'allow_team 关闭');
    antiSocket.emit('change_game_conf', { allow_team: false });
    await teamOff;
    const teamBackOn = waitRoomUpdate(antiSocket, (d) => d.allow_team === true, 10_000, 'allow_team 重新开启');
    antiSocket.emit('change_game_conf', { allow_team: true });
    await teamBackOn;
    log('anti-human 校验通过：allowTeam=true 的房间允许房主自由开关组队');

    const inTeam2 = waitRoomUpdate(
      antiSocket,
      (d) => d.players.find((p) => p.uid === NORMAL_USER)?.team === 2,
      10_000,
      '普通用户切换到 2 队',
    );
    antiSocket.emit('change_team', { team: 2 });
    await inTeam2;
    antiSocket.emit('change_ready', { ready: true });
    const antiInitDeadline = Date.now() + 20_000;
    while (Date.now() < antiInitDeadline && !sawAntiInitMap) {
      await sleep(500);
    }
    if (!sawAntiInitMap) {
      return finish(1, 'anti-human 校验失败：房主准备后 bot 未自动进入对局（未收到 [对局] 初始化）');
    }
    log('anti-human 校验通过：房主准备后 bot 自动进入对局');
  } finally {
    antiSocket.disconnect();
    const antiStopped = await api(baseUrl, adminToken, 'POST', '/api/admin/bots/stop', { id: antiBotId });
    if (antiStopped.status !== 200) {
      return finish(1, `anti-human 校验失败：停止 bot 出错（HTTP ${antiStopped.status}）`);
    }
    log('anti-human Bot 已停止');
  }

  // 组队禁止校验（独立房间，避免干扰对局校验）：
  // 1) 普通用户作房主开启组队（基线：无托管 bot 时可开）；
  // 2) 超管再启动一个托管 bot 进该房间，bot 进房应强制关闭组队；
  // 3) 房主再次尝试开启组队应被服务端拒绝（收到回发的 room_update 且始终为 false）；
  // 4) 停止该 bot，避免污染后续重启恢复的状态文件校验（期望仅 1 条记录）。
  const guardSocket = ioClient(baseUrl, {
    auth: { token: userToken },
    transports: ['websocket'],
  });
  await new Promise((resolve, reject) => {
    guardSocket.once('connect', resolve);
    guardSocket.once('connect_error', reject);
  });
  guardSocket.emit('join_game_room', { room: GUARD_ROOM });
  const guardJoined = await waitRoomUpdate(
    guardSocket,
    (d) => Array.isArray(d.players) && d.players.length === 1,
    10_000,
    'guard 房间首次 room_update',
  );
  if (guardJoined.players[0].uid !== NORMAL_USER) {
    return finish(1, `组队禁止校验失败：guard 房间房主应为 ${NORMAL_USER}，实际 ${guardJoined.players[0].uid}`);
  }
  const allowTeamOn = waitRoomUpdate(guardSocket, (d) => d.allow_team === true, 10_000, 'allow_team 开启');
  guardSocket.emit('change_game_conf', { allow_team: true });
  await allowTeamOn;
  log('组队禁止基线校验通过：无托管 bot 时房主可正常开启组队');

  const started2 = await api(baseUrl, adminToken, 'POST', '/api/admin/bots/start', {
    username: BOT_USER_2,
    room: GUARD_ROOM,
    template: 'simple-strategy-bot',
    allowTeam: false,
  });
  if (started2.status !== 200 || !started2.data?.bot?.id) {
    return finish(1, `组队禁止校验失败：启动第二个 bot 出错（HTTP ${started2.status}）`);
  }
  const bot2Id = started2.data.bot.id;
  try {
    await waitRoomUpdate(
      guardSocket,
      (d) =>
        d.allow_team === false &&
        d.players.some((p) => p.uid === BOT_USER_2 && p.server_bot === true),
      15_000,
      '托管 bot 进房强制关闭组队',
    );
    log('组队禁止校验通过：托管 bot 进房后已开启的组队被强制关闭');

    const rejectProbe = new Promise((resolve, reject) => {
      let sawUpdate = false;
      const cleanupProbe = () => {
        clearTimeout(timer);
        guardSocket.off('room_update', handler);
      };
      const handler = (d) => {
        if (d.allow_team === true) {
          cleanupProbe();
          reject(new Error('托管 bot 房间内房主的开启组队请求未被拒绝'));
          return;
        }
        sawUpdate = true;
      };
      const timer = setTimeout(() => {
        cleanupProbe();
        if (sawUpdate) {
          resolve();
        } else {
          reject(new Error('拒绝后未收到 room_update 回发'));
        }
      }, 3_000);
      guardSocket.on('room_update', handler);
    });
    guardSocket.emit('change_game_conf', { allow_team: true });
    await rejectProbe;
    log('组队禁止校验通过：托管 bot 房间内房主的开启组队请求被服务端拒绝');
  } finally {
    guardSocket.disconnect();
    const stopped2 = await api(baseUrl, adminToken, 'POST', '/api/admin/bots/stop', { id: bot2Id });
    if (stopped2.status !== 200) {
      return finish(1, `组队禁止校验失败：停止第二个 bot 出错（HTTP ${stopped2.status}）`);
    }
  }

  // 等待对局开始并积累足够的实际操作日志。
  const gameDeadline = Date.now() + GAME_TIMEOUT_MS;
  while (Date.now() < gameDeadline) {
    if (sawInitMap && attackCount >= REQUIRED_ATTACKS) {
      break;
    }
    await sleep(500);
  }
  if (!sawInitMap) {
    return finish(1, '对局校验失败：托管 bot 未收到 init_map');
  }
  if (attackCount < REQUIRED_ATTACKS) {
    return finish(1, `对局校验失败：托管 bot 实际 attack 操作 ${attackCount}/${REQUIRED_ATTACKS}`);
  }
  log(`对局校验通过：收到 init_map，累计 ${attackCount} 条实际 attack 操作`);

  // 重启恢复校验：运行中 bot 应已持久化到状态文件。
  const stateFile = path.join(dataDir, 'server-bots.json');
  let savedState = null;
  try {
    savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (error) {
    return finish(1, `状态文件校验失败：读取/解析 ${stateFile} 出错（${error.message}）`);
  }
  if (
    !Array.isArray(savedState) ||
    savedState.length !== 1 ||
    savedState[0]?.username !== BOT_USER ||
    savedState[0]?.room !== ROOM ||
    savedState[0]?.template !== 'simple-strategy-bot' ||
    savedState[0]?.allowTeam !== false
  ) {
    return finish(1, `状态文件校验失败：内容 ${JSON.stringify(savedState)}`);
  }
  log('状态文件校验通过：运行中 bot 已持久化（username + room + template + allowTeam）');

  // 不停止 bot 直接杀掉服务器，同数据目录重启后应自动以原配置恢复。
  const serverExited = new Promise((resolve) => server.once('exit', resolve));
  killChild(server);
  await serverExited;
  log('旧服务器已停止（bot 未手动停止），开始重启……');

  spawnServer('服务器(重启)');
  await waitTcpReady(port, SERVER_READY_TIMEOUT_MS);
  log('服务器已重启');

  const restoreDeadline = Date.now() + 20_000;
  let restoredBot = null;
  while (Date.now() < restoreDeadline) {
    const { status, data } = await api(baseUrl, adminToken, 'GET', '/api/admin/bots');
    if (status === 200 && Array.isArray(data?.items)) {
      const found = data.items.find((item) => item.username === BOT_USER && item.room === ROOM);
      if (found?.connected) {
        restoredBot = found;
        break;
      }
    }
    await sleep(500);
  }
  if (!restoredBot) {
    return finish(1, '重启恢复校验失败：重启后 bot 未按原配置自动恢复或未连上服务器');
  }
  if (restoredBot.template !== 'simple-strategy-bot' || restoredBot.allowTeam !== false) {
    return finish(1, `重启恢复校验失败：恢复记录 template/allowTeam 不符 ${JSON.stringify(restoredBot)}`);
  }
  log(`重启恢复校验通过：bot 已自动恢复（id=${restoredBot.id}，房间 ${restoredBot.room}，模板 ${restoredBot.template}，组队 ${restoredBot.allowTeam}）`);

  // 停止 bot 并确认列表清空、状态文件已清除。
  const stopped = await api(baseUrl, adminToken, 'POST', '/api/admin/bots/stop', { id: restoredBot.id });
  if (stopped.status !== 200) {
    return finish(1, `停止 bot 失败：HTTP ${stopped.status} ${JSON.stringify(stopped.data)}`);
  }
  const listed = await api(baseUrl, adminToken, 'GET', '/api/admin/bots');
  const remaining = Array.isArray(listed.data?.items) ? listed.data.items.length : -1;
  if (remaining !== 0) {
    return finish(1, `停止校验失败：bot 列表剩余 ${remaining} 个`);
  }
  const clearedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!Array.isArray(clearedState) || clearedState.length !== 0) {
    return finish(1, `停止校验失败：状态文件未清除（${JSON.stringify(clearedState)}）`);
  }
  log('停止 API 校验通过：bot 已停止、列表清空且状态文件已清除');

  finish(0, '冒烟测试全部通过');
}

main().catch((error) => finish(1, `测试异常：${error.stack || error.message}`));
