// Roka random-patch-bot 集成测试：
// 1) 用临时数据目录 + 随机端口启动 dist/server.js（注入 ROKA_BOT_TOKENS 合成用户）；
// 2) 启动两个 random-patch-bot 加入同一房间并自动 ready，触发自动开局；
// 3) 解析 bot 标准输出，要求双方都收到 init_map 且合计收到 >=10 个有效回合 update。
// 成功 exit 0，失败/超时 exit 1。全程硬上限 120 秒。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const botDir = path.join(rootDir, 'bot-template', 'random-patch-bot');
const serverEntry = path.join(rootDir, 'dist', 'server.js');

const HARD_TIMEOUT_MS = 120_000;
const SERVER_READY_TIMEOUT_MS = 20_000;
const GAME_TIMEOUT_MS = 60_000;
const REQUIRED_TURNS = 10;

const startedAt = Date.now();
const children = new Set();
let dataDir = null;
let finished = false;

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[test-bot ${elapsed}s] ${message}`);
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
  // 给子进程一点退出时间后结束。
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

async function main() {
  ensureBuild();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-test-'));
  const port = await findFreePort();
  log(`临时数据目录：${dataDir}，端口：${port}`);

  const server = spawnLogged('服务器', process.execPath, [serverEntry, '--port', String(port)], {
    cwd: rootDir,
    env: {
      ...process.env,
      ROKA_DATA_DIR: dataDir,
      ROKA_BOT_TOKENS: 'test-token-a:bot_alpha,test-token-b:bot_beta',
    },
  });
  server.stderr.on('data', (chunk) => log(`服务器 stderr: ${String(chunk).trim()}`));

  log('等待服务器就绪……');
  await waitTcpReady(port, SERVER_READY_TIMEOUT_MS);
  log('服务器已就绪');

  // 启动两个 bot。
  const bots = ['a', 'b'].map((suffix, index) => {
    const username = index === 0 ? 'bot_alpha' : 'bot_beta';
    const child = spawnLogged(`bot_${suffix}`, process.execPath, [path.join(botDir, 'index.js')], {
      cwd: botDir,
      env: {
        ...process.env,
        BOT_SERVER: `http://127.0.0.1:${port}`,
        BOT_ROOM: 'bottest',
        BOT_TOKEN: `test-token-${suffix}`,
        BOT_AUTO_READY: '1',
      },
    });
    return { name: `bot_${suffix}(${username})`, child, sawInitMap: false };
  });

  let turnCount = 0;
  let gameStarted = false;
  const gameDeadline = Date.now() + GAME_TIMEOUT_MS;

  await new Promise((resolve) => {
    const handleLine = (bot, line) => {
      if (line.includes('init_map')) {
        if (!bot.sawInitMap) {
          bot.sawInitMap = true;
          log(`${bot.name} 收到 init_map（对局开始）`);
        }
      } else if (/\[bot\] turn \d+:/.test(line)) {
        turnCount += 1;
        if (turnCount === REQUIRED_TURNS) {
          log(`累计收到 ${turnCount} 个回合 update，达到成功判据`);
        }
      }

      if (!gameStarted && bots.every((item) => item.sawInitMap)) {
        gameStarted = true;
        log('双方均已进入对局');
      }
      if (gameStarted && turnCount >= REQUIRED_TURNS) {
        resolve();
      }
    };

    for (const bot of bots) {
      let buffer = '';
      bot.child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            console.log(`    ${bot.name} | ${trimmed}`);
            handleLine(bot, trimmed);
          }
        }
      });
      bot.child.stderr.on('data', (chunk) => {
        log(`${bot.name} stderr: ${String(chunk).trim()}`);
      });
      bot.child.once('exit', () => {
        if (!finished) {
          log(`${bot.name} 意外退出`);
          resolve();
        }
      });
    }

    const timer = setInterval(() => {
      if (Date.now() > gameDeadline) {
        clearInterval(timer);
        log(`等待对局超时（${GAME_TIMEOUT_MS / 1000}s）`);
        resolve();
      }
    }, 500);
    timer.unref();
  });

  const initCount = bots.filter((bot) => bot.sawInitMap).length;
  if (gameStarted && turnCount >= REQUIRED_TURNS) {
    finish(0, `测试通过：${initCount}/2 个 bot 收到 init_map，累计 ${turnCount} 个回合 update`);
  } else {
    finish(1, `测试失败：init_map=${initCount}/2，回合 update=${turnCount}/${REQUIRED_TURNS}`);
  }
}

main().catch((error) => finish(1, `测试异常：${error.stack || error.message}`));
