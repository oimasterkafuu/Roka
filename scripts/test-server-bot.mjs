// Roka 服务端托管策略 Bot 冒烟测试（issue #18）：
// 1) 临时数据目录 + dist/auth-store.js 直接造用户（首个用户 = 超级管理员）；
// 2) 启动 dist/server.js（ROKA_BOT_TOKENS 注入一个第三方 bot 合成用户）；
// 3) 以超管身份调 POST /api/admin/bots/start 在服务器进程内启动 simple-strategy-bot；
// 4) 校验：普通用户访问 bot API 被 403；bot 进房后 host 不是 bot（第三方 bot 进房后接任房主）；
// 5) 启动 random-patch-bot 作为对手触发开局，解析服务器 stdout 中 [server-bot] 日志，
//    要求收到 init_map 且发出 >=5 条实际 attack 操作；
// 6) 调 POST /api/admin/bots/stop 停止并确认列表清空。
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

const serverEntry = path.join(rootDir, 'dist', 'server.js');
const randomBotDir = path.join(rootDir, 'bot-template', 'random-patch-bot');

const HARD_TIMEOUT_MS = 120_000;
const SERVER_READY_TIMEOUT_MS = 20_000;
const GAME_TIMEOUT_MS = 60_000;
const REQUIRED_ATTACKS = 5;
const ROOM = 'smokeroom';
const ADMIN_USER = 'smoke_admin';
const BOT_USER = 'smoke_bot';
const NORMAL_USER = 'smoke_user';
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
  await store.register(NORMAL_USER, 'smoke-pass-3');
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
  log('已造用户：smoke_admin（超管）/ smoke_bot（bot 账号）/ smoke_user（普通用户）');

  const server = spawnLogged('服务器', process.execPath, [serverEntry, '--port', String(port)], {
    cwd: rootDir,
    env: {
      ...process.env,
      ROKA_DATA_DIR: dataDir,
      ROKA_BOT_TOKENS: `smoke-token:${RANDOM_BOT_USER}`,
    },
  });
  server.stderr.on('data', (chunk) => log(`服务器 stderr: ${String(chunk).trim()}`));

  let sawInitMap = false;
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
  log('普通用户访问 /api/admin/bots 被 403 拒绝（符合预期）');

  // 超管启动服务端托管策略 Bot。
  const started = await api(baseUrl, adminToken, 'POST', '/api/admin/bots/start', {
    username: BOT_USER,
    room: ROOM,
  });
  if (started.status !== 200 || !started.data?.bot?.id) {
    return finish(1, `启动 bot 失败：HTTP ${started.status} ${JSON.stringify(started.data)}`);
  }
  const botId = started.data.bot.id;
  log(`策略 Bot 已启动：id=${botId}`);

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

  // 停止 bot 并确认列表清空。
  const stopped = await api(baseUrl, adminToken, 'POST', '/api/admin/bots/stop', { id: botId });
  if (stopped.status !== 200) {
    return finish(1, `停止 bot 失败：HTTP ${stopped.status} ${JSON.stringify(stopped.data)}`);
  }
  const listed = await api(baseUrl, adminToken, 'GET', '/api/admin/bots');
  const remaining = Array.isArray(listed.data?.items) ? listed.data.items.length : -1;
  if (remaining !== 0) {
    return finish(1, `停止校验失败：bot 列表剩余 ${remaining} 个`);
  }
  log('停止 API 校验通过：bot 已停止且列表清空');

  finish(0, '冒烟测试全部通过');
}

main().catch((error) => finish(1, `测试异常：${error.stack || error.message}`));
