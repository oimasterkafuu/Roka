// 部署更新 UX 回归测试（spec-deploy-ux）：
// 场景 1（更新排队广播）：对局进行中触发 webhook，服务端进入「更新排队」状态——
//   响应 queued:true、所有客户端收到 deploy_queued、room_update 携带 update_queued、
//   对局房间收到宽限期提示消息。
// 场景 2（排队期禁开局）：排队期间新房间的就绪请求被拒绝（不开局 + 提示消息），
//   后进房客户端的首帧 room_update 同样带 update_queued（按钮禁用依据）。
// 场景 3（宽限清算）：ROKA_DEPLOY_GRACE_MS 宽限到期后，残余对局按当前名次
//   强制终局（game_end 帧 + 回放 id + 清算提示 + rating 结算生效）。
// 场景 4（dry-run 恢复）：ROKA_DEPLOY_DRY_RUN=1 跳过真实部署/重启，流程结束
//   后排队状态解除（deploy_queued {queued:false}），可以重新开局。
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
const GRACE_MS = 4_000;
const WEBHOOK_SECRET = 'deploy-test-secret';
const ROOM_GAME = 'depqu';
const ROOM_BLOCKED = 'depqu2';
const USER_A = 'dep_a';
const USER_B = 'dep_b';
const USER_C = 'dep_c';
const USER_D = 'dep_d';

const startedAt = Date.now();
const children = new Set();
const sockets = new Set();
let dataDir = null;
let finished = false;

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[test-deploy-update ${elapsed}s] ${message}`);
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
    tokenA: await sign(USER_A, 'deploy-pass-1'),
    tokenB: await sign(USER_B, 'deploy-pass-2'),
    tokenC: await sign(USER_C, 'deploy-pass-3'),
    tokenD: await sign(USER_D, 'deploy-pass-4'),
  };
}

/**
 * 最小房间客户端：connect 后进房，可选自动准备。
 * 暴露 init_map / update（含 game_end 帧）/ chat_message / deploy_queued / room_update 供断言。
 */
function createRoomClient(baseUrl, { cookie, room, autoReady = true, name }) {
  const socket = ioClient(baseUrl, {
    transports: ['websocket', 'polling'],
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
    gameEndFrames: [],
    chats: [],
    deployEvents: [],
    roomUpdates: [],
  };

  socket.on('set_id', (id) => {
    client.clientId = String(id || '');
    socket.emit('join_game_room', { room });
  });
  socket.on('init_map', (data) => {
    client.inits.push(data);
  });
  socket.on('update', (data) => {
    client.updates += 1;
    if (data && data.game_end) {
      client.gameEndFrames.push(data);
    }
  });
  socket.on('chat_message', (data) => {
    client.chats.push(String(data?.text ?? ''));
  });
  socket.on('deploy_queued', (data) => {
    client.deployEvents.push(data);
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

function lastRoomUpdate(client) {
  return client.roomUpdates[client.roomUpdates.length - 1];
}

function waitFor(condition, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = async () => {
      let ok = false;
      try {
        ok = await condition();
      } catch {
        ok = false;
      }
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`等待超时：${label}`));
        return;
      }
      setTimeout(check, 100);
    };
    void check();
  });
}

async function main() {
  ensureBuild();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-test-deploy-update-'));
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`临时数据目录：${dataDir}，端口：${port}，宽限期：${GRACE_MS}ms（dry-run）`);

  const { tokenA, tokenB, tokenC, tokenD } = await prepareUsers(dataDir);

  const server = spawn(process.execPath, [serverEntry, '--port', String(port)], {
    cwd: rootDir,
    env: {
      ...process.env,
      ROKA_DATA_DIR: dataDir,
      WEBHOOK_SECRET,
      ROKA_DEPLOY_GRACE_MS: String(GRACE_MS),
      ROKA_DEPLOY_DRY_RUN: '1',
    },
  });
  children.add(server);
  let serverLog = '';
  server.stdout.on('data', (chunk) => {
    serverLog += String(chunk);
  });
  server.stderr.on('data', (chunk) => log(`服务器 stderr: ${String(chunk).trim()}`));

  await waitTcpReady(port, SERVER_READY_TIMEOUT_MS);
  log('服务器已就绪');

  // 准备：A、B 在 ROOM_GAME 开局（对局进行中触发 webhook 才会进入排队状态）。
  const a = createRoomClient(baseUrl, { cookie: tokenA, room: ROOM_GAME, name: 'A' });
  const b = createRoomClient(baseUrl, { cookie: tokenB, room: ROOM_GAME, name: 'B' });
  await waitFor(() => a.inits.length > 0 && b.inits.length > 0, 10_000, 'A/B 对局开局');
  await waitFor(() => a.updates > 2, 5_000, '对局 update 流动');
  log('对局进行中，触发 webhook');

  // 场景 1：对局进行中触发 webhook → 进入「更新排队」状态并广播。
  const webhookAt = Date.now();
  const response = await fetch(`${baseUrl}/postreceive`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-webhook-secret': WEBHOOK_SECRET,
    },
    body: JSON.stringify({ ref: 'refs/heads/main' }),
  });
  if (response.status !== 202) {
    throw new Error(`webhook 响应状态异常：${response.status}`);
  }
  const responseBody = await response.json();
  if (responseBody.queued !== true) {
    throw new Error(`有对局在跑时 webhook 应进入排队（queued:true），实际：${JSON.stringify(responseBody)}`);
  }
  log('场景 1a 通过：webhook 返回 queued:true');

  await waitFor(
    () => a.deployEvents.some((event) => event?.queued === true),
    5_000,
    'A 收到 deploy_queued 广播',
  );
  await waitFor(() => lastRoomUpdate(a)?.update_queued === true, 5_000, 'room_update 携带 update_queued');
  if (!a.chats.some((text) => text.includes('按当前名次结算'))) {
    throw new Error('对局房间未收到宽限期清算提示消息');
  }
  log('场景 1b 通过：客户端收到 deploy_queued + room_update.update_queued + 提示消息');

  // 场景 2：排队期间禁止开新局（C/D 在另一个房间就绪也不得开局）。
  const c = createRoomClient(baseUrl, { cookie: tokenC, room: ROOM_BLOCKED, autoReady: false, name: 'C' });
  await waitFor(() => c.clientId !== '', 5_000, 'C 进房');
  const d = createRoomClient(baseUrl, { cookie: tokenD, room: ROOM_BLOCKED, autoReady: false, name: 'D' });
  await waitFor(() => d.clientId !== '', 5_000, 'D 进房');
  // 后进房客户端的首帧 room_update 同样带 update_queued（前端据此禁用开始按钮）。
  if (lastRoomUpdate(c)?.update_queued !== true) {
    throw new Error('后进房客户端的 room_update 未携带 update_queued:true');
  }
  c.socket.emit('change_ready', { ready: true });
  d.socket.emit('change_ready', { ready: true });
  await waitFor(
    () => c.chats.some((text) => text.includes('系统即将排队更新，请稍等')),
    5_000,
    '就绪被拒提示消息',
  );
  await sleep(1500);
  if (c.inits.length > 0 || d.inits.length > 0) {
    throw new Error('排队期间仍然开局（收到 init_map），禁开局失效');
  }
  log('场景 2 通过：排队期间就绪被拒绝、未开局且收到提示');

  // 场景 3：宽限期到期 → 残余对局按当前名次清算（game_end 帧 + 回放 + 提示）。
  const updatesAtWebhook = a.updates;
  await waitFor(() => a.gameEndFrames.length > 0, GRACE_MS + 10_000, '宽限到期清算终局帧');
  const settleElapsed = Date.now() - webhookAt;
  if (settleElapsed < GRACE_MS * 0.75) {
    throw new Error(`清算过早发生（${settleElapsed}ms < 宽限期 ${GRACE_MS}ms），宽限期未生效`);
  }
  if (a.updates <= updatesAtWebhook) {
    throw new Error('宽限期内对局没有继续推进（宽限期应允许继续打完）');
  }
  const endFrame = a.gameEndFrames[a.gameEndFrames.length - 1];
  if (typeof endFrame.replay !== 'string' || endFrame.replay.length === 0) {
    throw new Error('清算终局帧缺少回放 id（回放未正常存档）');
  }
  if (!a.chats.some((text) => text.includes('按当前名次提前结算'))) {
    throw new Error('未收到清算提示消息');
  }
  log(`场景 3a 通过：宽限 ${settleElapsed}ms 后按当前名次清算，回放 ${endFrame.replay}`);

  // 清算走正常结算路径：双方 ratingGames 应已 +1（applyGameResult 异步，轮询等待）。
  let ratingGames = 0;
  await waitFor(async () => {
    const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { cookie: `auth_token=${encodeURIComponent(tokenA)}` },
    });
    const me = await meResponse.json();
    ratingGames = Number(me.rating?.ratingGames ?? 0);
    return ratingGames >= 1;
  }, 5_000, '清算后 rating 结算');
  log(`场景 3b 通过：rating 已结算（${USER_A} ratingGames=${ratingGames}）`);

  // 场景 4：dry-run 部署流程结束后解除排队状态，可以重新开局。
  await waitFor(() => serverLog.includes('ROKA_DEPLOY_DRY_RUN'), 10_000, 'dry-run 部署日志');
  await waitFor(
    () => c.deployEvents.some((event) => event?.queued === false) && lastRoomUpdate(c)?.update_queued === false,
    5_000,
    '排队状态解除广播',
  );
  c.socket.emit('change_ready', { ready: true });
  d.socket.emit('change_ready', { ready: true });
  await waitFor(() => c.inits.length > 0 && d.inits.length > 0, 10_000, '排队解除后重新开局');
  log('场景 4 通过：dry-run 结束后排队状态解除，可以重新开局');

  finish(0, '全部部署更新场景通过');
}

main().catch((error) => finish(1, `测试失败：${error.stack || error.message}`));
