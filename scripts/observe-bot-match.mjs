// Roka bot 对局观测器：
// 1) 临时数据目录 + 随机端口启动 dist/server.js（注入 ROKA_BOT_TOKENS 合成用户）；
// 2) 进程内 recorder 以观战身份先进房（成为房主），设置速度/地图种子，逐 turn
//    合并 diff 帧并记录完整盘面快照；
// 3) 按 OBS_BOTS 启动 bot 子进程（strategy / random），捕获 stdout 操作日志；
// 4) game_end（或超时）后对本局做病理分析：前线停滞、往返抖动、送兵、切断无救援、
//    主城沦陷时兵力分布等，输出报告。
//
// 用法：
//   node scripts/observe-bot-match.mjs
// 环境变量：
//   OBS_BOTS=strategy:alpha,strategy:beta   参赛 bot（默认两个 strategy）
//   OBS_SPEED=4                             游戏速度 0.5–4（默认 4）
//   OBS_MAP_TOKEN=bot-obs-v1                地图种子（默认固定，便于 A/B 对比）
//   OBS_MAP_MODE=random                     地图类型（random/maze/archipelago/mediterranean）
//   OBS_MAX_MS=240000                       单局硬上限
//   OBS_OUT=data/observe-<ts>               输出目录（frames.jsonl + *.log + report.txt）

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(rootDir, 'dist', 'server.js');
const strategyBotDir = path.join(rootDir, 'bot-template', 'simple-strategy-bot');
const randomBotDir = path.join(rootDir, 'bot-template', 'random-patch-bot');

const HARD_TIMEOUT_MS = Number.parseInt(process.env.OBS_MAX_MS || '240000', 10) + 60_000;
const GAME_MAX_MS = Number.parseInt(process.env.OBS_MAX_MS || '240000', 10);
const SPEED = process.env.OBS_SPEED || '4';
const MAP_TOKEN = process.env.OBS_MAP_TOKEN || 'bot-obs-v1';
const MAP_MODE = process.env.OBS_MAP_MODE || 'random';
const OUT_DIR = process.env.OBS_OUT || path.join(rootDir, 'data', `observe-${Date.now()}`);
const BOT_SPECS = (process.env.OBS_BOTS || 'strategy:alpha,strategy:beta')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => {
    const [kind, name] = item.split(':');
    return { kind: kind || 'strategy', name: name || `bot_${kind}` };
  });

const startedAt = Date.now();
const children = new Set();
let dataDir = null;
let server = null;
let recorderSocket = null;
let finished = false;

function log(message) {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[observe ${elapsed}s] ${message}`);
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
  if (recorderSocket) {
    recorderSocket.disconnect();
  }
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* 尽力清理 */
    }
  }
}

function finish(code, message) {
  if (finished) {
    return;
  }
  finished = true;
  log(message);
  cleanup();
  setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => finish(1, '收到 SIGINT，中止'));
process.on('SIGTERM', () => finish(1, '收到 SIGTERM，中止'));
setTimeout(() => finish(1, `超过硬上限 ${HARD_TIMEOUT_MS / 1000}s`), HARD_TIMEOUT_MS).unref();

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

function ensureBuild() {
  if (fs.existsSync(serverEntry)) {
    return;
  }
  log('dist/server.js 不存在，先执行 pnpm run build');
  const result = spawnSync('pnpm', ['run', 'build'], { cwd: rootDir, stdio: 'inherit' });
  if (result.status !== 0 || !fs.existsSync(serverEntry)) {
    throw new Error('构建失败');
  }
}

/* ---------- 帧记录器（观战 socket） ---------- */

function createRecorder(port, room, frames) {
  return new Promise((resolve) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      auth: { token: 'obs-token-recorder' },
      reconnection: false,
    });
    recorderSocket = socket;
    const rec = {
      n: 0,
      m: 0,
      gridType: [],
      armyCnt: [],
      isolated: [],
      lastTurn: -1,
      gameEnd: false,
      playerIds: [],
    };
    const applyDiff = (diff, target) => {
      if (!Array.isArray(diff)) {
        return;
      }
      for (let i = 0; i + 1 < diff.length; i += 2) {
        const idx = Number.parseInt(String(diff[i]), 10);
        if (Number.isFinite(idx) && idx >= 0 && idx < target.length) {
          target[idx] = diff[i + 1];
        }
      }
    };
    socket.on('connect', () => {
      log('recorder 已连接，进房观战');
      socket.emit('join_game_room', { room });
    });
    let confSent = false;
    socket.on('room_update', (data) => {
      if (confSent || !data || data.in_game) {
        return;
      }
      // players[].sid 是 md5 后的 client_id，不是 socket.id。
      const self = (data.players || []).find((p) => String(p?.sid || '') === rec.clientId);
      if (!self) {
        return;
      }
      // 先进房的 recorder 是房主：转观战（team 0）并配置速度/地图，随后 bot 进房准备开局。
      if (Number(self.team) !== 0) {
        socket.emit('change_team', { team: 0 });
        return;
      }
      confSent = true;
      socket.emit('change_game_conf', { speed: Number(SPEED), map_mode: MAP_MODE, map_token: MAP_TOKEN });
      resolve(rec);
    });
    socket.on('set_id', (id) => {
      rec.clientId = String(id || '');
    });
    socket.on('init_map', (data) => {
      rec.n = Number.parseInt(String(data?.n ?? '0'), 10) || 0;
      rec.m = Number.parseInt(String(data?.m ?? '0'), 10) || 0;
      rec.gridType = new Array(rec.n * rec.m).fill(200);
      rec.armyCnt = new Array(rec.n * rec.m).fill(0);
      rec.isolated = new Array(rec.n * rec.m).fill(0);
      rec.lastTurn = -1;
      rec.playerIds = Array.isArray(data?.player_ids) ? data.player_ids.map(String) : [];
      log(`对局开始：${rec.n}x${rec.m}，${rec.playerIds.length} 名玩家`);
    });
    socket.on('update', (payload) => {
      if (rec.n === 0 || !payload) {
        return;
      }
      if (payload.is_diff) {
        if (rec.lastTurn < 0) {
          return; // 还没拿到全量基准帧
        }
        applyDiff(payload.grid_type, rec.gridType);
        applyDiff(payload.army_cnt, rec.armyCnt);
        applyDiff(payload.isolated, rec.isolated);
      } else if (Array.isArray(payload.grid_type) && payload.grid_type.length === rec.n * rec.m) {
        rec.gridType = payload.grid_type.slice();
        rec.armyCnt = payload.army_cnt.slice();
        rec.isolated = Array.isArray(payload.isolated) ? payload.isolated.slice() : rec.isolated;
      } else {
        return;
      }
      const turn = Number.parseInt(String(payload.turn ?? '-1'), 10);
      if (!Number.isFinite(turn) || turn < 0 || turn === rec.lastTurn) {
        return;
      }
      rec.lastTurn = turn;
      if (rec.gameEnd) {
        return; // 终局后 bot 可能秒开第二局，帧不再记录（进程随即被 SIGKILL）
      }
      frames.push({
        turn,
        grid_type: rec.gridType,
        army_cnt: rec.armyCnt,
        isolated: rec.isolated,
      });
      rec.gridType = rec.gridType.slice();
      rec.armyCnt = rec.armyCnt.slice();
      rec.isolated = rec.isolated.slice();
      if (payload.game_end) {
        rec.gameEnd = true;
      }
    });
  });
}

/* ---------- 病理分析 ---------- */

function ownerOf(code) {
  return typeof code === 'number' && code < 200 ? code % 50 : 0;
}

function parseBotOps(logText, m) {
  // 解析 strategy bot 日志：turn N: attack (x,y)->(dx,dy) mode=K [tag]
  const ops = [];
  const re = /turn (\d+): attack \((\d+),(\d+)\)->\((\d+),(\d+)\) mode=(\d+)(?: \[([^\]]+)\])?/;
  for (const line of logText.split('\n')) {
    const match = re.exec(line);
    if (!match) {
      continue;
    }
    const [, turn, x, y, dx, dy, mode, tag] = match;
    ops.push({
      turn: Number(turn),
      from: Number(x) * m + Number(y),
      to: Number(dx) * m + Number(dy),
      mode: Number(mode),
      tag: tag || '',
    });
  }
  return ops;
}

function parseClientId(logText) {
  const match = /client_id: ([0-9a-f]+)/.exec(logText);
  return match ? match[1] : '';
}

function analyze(frames, n, m, botLogs, playerIds, botNames) {
  const report = [];
  const total = n * m;
  const dirs = [-m, m, -1, 1];
  const inBounds = (idx, off) => {
    if (off === -1) {
      return idx % m !== 0;
    }
    if (off === 1) {
      return idx % m !== m - 1;
    }
    const next = idx + off;
    return next >= 0 && next < total;
  };
  const neighborsOf = (idx) => {
    const out = [];
    for (const off of dirs) {
      if (inBounds(idx, off)) {
        out.push(idx + off);
      }
    }
    return out;
  };

  const turnCount = frames.length;
  const frameAt = new Map(frames.map((f) => [f.turn, f]));
  const players = playerIds.map((_, i) => i + 1);

  // playerId → bot 日志/名字：按日志里的 client_id（= player_ids 的 md5）对齐，
  // 座位顺序与进房先后无关。
  const logByPlayer = new Map();
  const nameByPlayer = new Map();
  botLogs.forEach((text, i) => {
    const clientId = parseClientId(text);
    const seat = playerIds.indexOf(clientId);
    if (seat >= 0) {
      logByPlayer.set(seat + 1, text);
      nameByPlayer.set(seat + 1, botNames[i] || `P${seat + 1}`);
    }
  });

  // 终局归属：最后一帧仍存活的玩家（有领土）判胜。
  const lastFrame = frames[frames.length - 1];
  const summary = [];
  for (const p of players) {
    let land = 0;
    let army = 0;
    let crowns = 0;
    for (let idx = 0; idx < total; idx += 1) {
      if (ownerOf(lastFrame.grid_type[idx]) === p) {
        land += 1;
        army += lastFrame.army_cnt[idx];
        const code = lastFrame.grid_type[idx];
        if (code >= 100 && code < 150) {
          crowns += 1;
        }
      }
    }
    summary.push({ player: p, name: nameByPlayer.get(p) || `P${p}(观战/未知)`, land, army, crowns });
  }
  summary.sort((a, b) => b.land - a.land);
  report.push(`对局共 ${turnCount} tick；终局：${summary.map((s) => `${s.name} 地${s.land} 兵${s.army} 冠${s.crowns}`).join('；')}`);

  for (const p of players) {
    const name = nameByPlayer.get(p);
    if (!name) {
      continue; // 观战 recorder 等非 bot 座位不分析
    }
    const ops = parseBotOps(logByPlayer.get(p) || '', m);

    /* 1) 往返抖动：t 时刻 a→b，随后 3 tick 内 b→a */
    let jitter = 0;
    const attackOps = ops.filter((op) => op.tag !== '');
    for (let i = 0; i < attackOps.length; i += 1) {
      for (let j = i + 1; j < attackOps.length && attackOps[j].turn <= attackOps[i].turn + 3; j += 1) {
        if (attackOps[j].from === attackOps[i].to && attackOps[j].to === attackOps[i].from) {
          jitter += 1;
          break;
        }
      }
    }

    /* 2) 送兵：攻击未占领且推出量 <= 守军（纯损耗） */
    let feeds = 0;
    let feedArmy = 0;
    for (const op of attackOps) {
      const before = frameAt.get(op.turn - 1) || frameAt.get(op.turn);
      const after = frameAt.get(op.turn + 1);
      if (!before || !after) {
        continue;
      }
      const targetOwner = ownerOf(before.grid_type[op.to]);
      if (targetOwner === p || targetOwner === 0) {
        continue; // 中立/己方：扩张与调兵不算送兵
      }
      const captured = ownerOf(after.grid_type[op.to]) === p;
      if (!captured && ownerOf(after.grid_type[op.to]) === targetOwner) {
        const lost = Math.max(0, before.army_cnt[op.from] - after.army_cnt[op.from] - 1);
        if (lost >= 4) {
          feeds += 1;
          feedArmy += lost;
        }
      }
    }

    /* 3) 前线停滞：兵力 >=10 的可操作格，邻格有可吃目标却连续 >=15 tick 未动 */
    let stagnantCellTurns = 0;
    let stagnationRuns = 0;
    let runLength = 0;
    const cellStagnant = new Map(); // idx -> consecutive stagnant turns
    for (const frame of frames) {
      let anyStagnant = false;
      for (let idx = 0; idx < total; idx += 1) {
        if (ownerOf(frame.grid_type[idx]) !== p || frame.isolated[idx] > 0 || frame.army_cnt[idx] < 10) {
          cellStagnant.delete(idx);
          continue;
        }
        let capturable = false;
        for (const nb of neighborsOf(idx)) {
          if (frame.grid_type[nb] === 201) {
            continue;
          }
          const nbOwner = ownerOf(frame.grid_type[nb]);
          if (nbOwner !== p && frame.army_cnt[idx] - 1 > frame.army_cnt[nb]) {
            capturable = true;
            break;
          }
        }
        if (!capturable) {
          cellStagnant.delete(idx);
          continue;
        }
        const prev = cellStagnant.get(idx) || 0;
        cellStagnant.set(idx, prev + 1);
        if (prev + 1 === 15) {
          stagnationRuns += 1;
        }
        if (prev + 1 >= 15) {
          stagnantCellTurns += 1;
          anyStagnant = true;
        }
      }
      runLength = Math.max(runLength, ...[...cellStagnant.values()], 0);
      void anyStagnant;
    }

    /* 4) 切断无救援：孤军区 >=3 格且最终全部丢失（主人变为非 p），期间无向该区
          邻格发起过攻击 */
    let cutoffsIgnored = 0;
    let cutoffsTotal = 0;
    let cutoffRegionCells = 0;
    let isolatedSince = new Map(); // idx -> first isolated turn
    let regionOpen = false;
    let regionStart = 0;
    let regionCells = new Set();
    let regionRescued = false;
    const closeRegion = (endTurn) => {
      if (!regionOpen) {
        return;
      }
      regionOpen = false;
      if (regionCells.size < 3) {
        return;
      }
      cutoffsTotal += 1;
      cutoffRegionCells += regionCells.size;
      const survived = [...regionCells].some((idx) => {
        const f = frameAt.get(endTurn);
        return f && ownerOf(f.grid_type[idx]) === p;
      });
      if (!survived) {
        // 全部丢失：检查窗口内是否有救援性攻击（目标格与任一孤军格相邻）
        const rescued = ops.some(
          (op) =>
            op.turn >= regionStart &&
            op.turn <= endTurn &&
            [...regionCells].some((idx) => neighborsOf(idx).includes(op.to)),
        );
        if (!rescued) {
          cutoffsIgnored += 1;
        }
        void regionRescued;
      }
    };
    for (const frame of frames) {
      const currentIsolated = new Set();
      for (let idx = 0; idx < total; idx += 1) {
        if (ownerOf(frame.grid_type[idx]) === p && frame.isolated[idx] > 0) {
          currentIsolated.add(idx);
        }
      }
      if (currentIsolated.size > 0) {
        if (!regionOpen) {
          regionOpen = true;
          regionStart = frame.turn;
          regionCells = new Set();
        }
        for (const idx of currentIsolated) {
          regionCells.add(idx);
        }
      } else if (regionOpen) {
        closeRegion(frame.turn);
      }
      for (const idx of currentIsolated) {
        if (!isolatedSince.has(idx)) {
          isolatedSince.set(idx, frame.turn);
        }
      }
      for (const idx of [...isolatedSince.keys()]) {
        if (!currentIsolated.has(idx)) {
          isolatedSince.delete(idx);
        }
      }
    }
    closeRegion(frames[frames.length - 1]?.turn ?? 0);

    /* 5) 主城沦陷时仍有大规模闲散兵力（没回防） */
    let crownLostWithArmy = null;
    for (let i = 1; i < frames.length; i += 1) {
      const prev = frames[i - 1];
      const cur = frames[i];
      for (let idx = 0; idx < total; idx += 1) {
        const prevCode = prev.grid_type[idx];
        const wasMyCrown = prevCode >= 100 && prevCode < 150 && prevCode - 100 === p;
        if (!wasMyCrown) {
          continue;
        }
        const curOwner = ownerOf(cur.grid_type[idx]);
        if (curOwner !== p && curOwner > 0) {
          let myArmy = 0;
          for (let c = 0; c < total; c += 1) {
            if (ownerOf(prev.grid_type[c]) === p) {
              myArmy += prev.army_cnt[c];
            }
          }
          if (myArmy >= 60 && !crownLostWithArmy) {
            crownLostWithArmy = { turn: cur.turn, army: myArmy };
          }
        }
      }
    }

    report.push(
      [
        `--- ${name} ---`,
        `操作总数=${attackOps.length}（含 build 以外的 attack）`,
        `往返抖动=${jitter}`,
        `送兵（未占领且纯损耗>=4）=${feeds} 次，累计约 ${feedArmy} 兵`,
        `前线停滞：${stagnationRuns} 段，累计 ${stagnantCellTurns} 格·tick，最长连续 ${runLength} tick`,
        `切断事件（>=3 格）：${cutoffsTotal} 起（涉及 ${cutoffRegionCells} 格），无救援且全灭=${cutoffsIgnored} 起`,
        crownLostWithArmy
          ? `主城被占时全军仍有 ${crownLostWithArmy.army} 兵（turn ${crownLostWithArmy.turn}）——回防失职`
          : '主城被占时无大量闲散兵力（或未沦陷）',
      ].join('\n'),
    );
  }
  return report.join('\n');
}

/* ---------- 主流程 ---------- */

async function main() {
  ensureBuild();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-observe-'));
  const port = await findFreePort();
  const room = `obs${Math.floor(Math.random() * 1e6)}`;
  log(`数据目录 ${dataDir}，端口 ${port}，房间 ${room}，输出 ${OUT_DIR}`);

  const tokenPairs = [
    ...BOT_SPECS.map((spec, i) => `obs-token-${i}:${spec.name}`),
    'obs-token-recorder:recorder',
  ].join(',');
  server = spawn(process.execPath, [serverEntry, '--port', String(port)], {
    cwd: rootDir,
    env: { ...process.env, ROKA_DATA_DIR: dataDir, ROKA_BOT_TOKENS: tokenPairs },
  });
  children.add(server);
  server.stderr.on('data', (chunk) => log(`服务器 stderr: ${String(chunk).trim()}`));

  await waitTcpReady(port, 20_000);
  log('服务器就绪');

  const frames = [];
  const rec = await createRecorder(port, room, frames);
  await new Promise((resolve) => setTimeout(resolve, 300));

  // legacy bot：从 main 分支导出旧版 simple-strategy-bot 到临时目录（A/B 对战基准）。
  let legacyDir = null;
  if (BOT_SPECS.some((spec) => spec.kind === 'legacy')) {
    legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-legacy-bot-'));
    const files = spawnSync('git', ['ls-tree', '-r', '--name-only', 'main', '--', 'bot-template/simple-strategy-bot'], {
      cwd: rootDir,
      encoding: 'utf8',
    })
      .stdout.split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('pnpm-lock.yaml'));
    for (const file of files) {
      const rel = path.relative('bot-template/simple-strategy-bot', file);
      const content = spawnSync('git', ['show', `main:${file}`], { cwd: rootDir, encoding: 'utf8' }).stdout;
      const dest = path.join(legacyDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
    log(`legacy bot 已从 main 导出 ${files.length} 个文件到 ${legacyDir}`);
  }

  // 启动参赛 bot
  const botLogs = BOT_SPECS.map(() => '');
  BOT_SPECS.forEach((spec, i) => {
    let command;
    let args;
    let cwd;
    if (spec.kind === 'legacy') {
      command = process.execPath;
      args = [path.join(legacyDir, 'index.js')];
      cwd = legacyDir;
    } else {
      const dir = spec.kind === 'random' ? randomBotDir : strategyBotDir;
      command = process.execPath;
      args = [path.join(dir, 'index.js')];
      cwd = dir;
    }
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        NODE_PATH: path.join(rootDir, 'node_modules'),
        BOT_SERVER: `http://127.0.0.1:${port}`,
        BOT_ROOM: room,
        BOT_TOKEN: `obs-token-${i}`,
        BOT_AUTO_READY: '1',
        BOT_ACTION_DELAY_MS: '30',
      },
    });
    children.add(child);
    const stream = fs.createWriteStream(path.join(OUT_DIR, `bot-${spec.name}.log`));
    child.stdout.on('data', (chunk) => {
      botLogs[i] += String(chunk);
      stream.write(chunk);
    });
    child.stderr.on('data', (chunk) => log(`${spec.name} stderr: ${String(chunk).trim()}`));
  });

  // 等待对局结束或超时
  const deadline = Date.now() + GAME_MAX_MS;
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (rec.gameEnd) {
        log(`对局在 ${rec.lastTurn} tick 结束`);
        clearInterval(timer);
        // 立刻 SIGKILL bot，防止它们重新准备开第二局。
        for (const child of children) {
          if (child !== server && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }
        resolve();
      } else if (Date.now() > deadline) {
        log(`对局超时（${GAME_MAX_MS / 1000}s），按平局分析`);
        clearInterval(timer);
        resolve();
      }
    }, 100);
    timer.unref();
  });

  for (const child of children) {
    if (child !== server) {
      killChild(child);
    }
  }

  // 落盘帧与分析报告
  const framesPath = path.join(OUT_DIR, 'frames.jsonl');
  const fd = fs.openSync(framesPath, 'w');
  for (const frame of frames) {
    fs.writeSync(fd, `${JSON.stringify(frame)}\n`);
  }
  fs.closeSync(fd);

  const botNames = BOT_SPECS.map((spec) => spec.name);
  const report = analyze(frames, rec.n, rec.m, botLogs, rec.playerIds, botNames);
  fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), `${report}\n`);
  console.log(`\n${report}\n`);
  finish(0, `观测完成，输出目录：${OUT_DIR}`);
}

main().catch((error) => finish(1, `异常：${error.stack || error.message}`));
