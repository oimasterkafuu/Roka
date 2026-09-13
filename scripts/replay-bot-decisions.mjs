// Roka bot 决策复盘器（离线）：
// 用 EventEmitter 假 socket 驱动真实的 simple-strategy-bot/strategy.js，把
// observe-bot-match 录制的 frames.jsonl 逐 turn 喂进去，完整复现该 bot 在
// 对局中的每个决策（队列镜像、防往返、威胁闩锁等跨 tick 状态全部真实运行）。
// 队列执行按服务端语义模拟：每 tick 依次弹出队首直到一条 op 通过
// chkMove/chkBuild 校验（失败计 skip），据此合成 lst_move 驱动镜像同步。
// 输出与该 bot 当时的 stdout 日志同格式，可 diff 验证复盘保真度。
//
// 用法：
//   node scripts/replay-bot-decisions.mjs --dir data/observe-default-ab3 --bot new
// 选项：
//   --from N --to M        只输出 turn 区间（默认全程）
//   --board T1,T2          在指定 turn 打印 ASCII 棋盘（owner 字母 + 兵力）
//   --cell x,y@T           解释某格在指定 turn 的状态（驻军/推兵/候选资格）
//   --validate             与 bot-<name>.log 对比下发的 attack/build 操作
//
// 局限：真实对局的 kills 由服务端推送，复盘按规则合成——玩家最后一座主城
// 消失即判出局。棋盘校验用「帧后状态」近似执行前状态，个别相位误差难免。

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'bot-template', 'simple-strategy-bot', 'index.js'));
const { attachStrategy } = require('./strategy');
const { buildContext } = require('./bot/board');

/* ---------- 参数 ---------- */
function parseArgs(argv) {
  const args = { from: -Infinity, to: Infinity, boards: new Set(), cells: [], validate: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--validate') {
      args.validate = true;
    } else if (a === '--dir') {
      args.dir = argv[++i];
    } else if (a === '--bot') {
      args.bot = argv[++i];
    } else if (a === '--from') {
      args.from = Number(argv[++i]);
    } else if (a === '--to') {
      args.to = Number(argv[++i]);
    } else if (a === '--board') {
      for (const t of argv[++i].split(',')) {
        args.boards.add(Number(t));
      }
    } else if (a === '--cell') {
      const [xy, t] = argv[++i].split('@');
      const [x, y] = xy.split(',').map(Number);
      args.cells.push({ x, y, turn: Number(t) });
    }
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.dir || !args.bot) {
  console.error('需要 --dir <observe目录> --bot <名字>');
  process.exit(1);
}
const botLogPath = path.join(args.dir, `bot-${args.bot}.log`);
const framesPath = path.join(args.dir, 'frames.jsonl');
const botLog = fs.readFileSync(botLogPath, 'utf8');
const frames = fs
  .readFileSync(framesPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const clientId = /client_id: ([0-9a-f]+)/.exec(botLog)?.[1] || '';
const initMatch = /init_map (\d+)x(\d+), playerId=(\d+)/.exec(botLog);
const n = Number(initMatch[1]);
const m = Number(initMatch[2]);
const playerId = Number(initMatch[3]);
const total = n * m;

/* ---------- 假 socket + 真实策略 ---------- */
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.id = 'fake-replay';
    this.emitted = [];
  }
  emit(type, payload) {
    if (type === 'attack' || type === 'build' || type === 'clear_queue') {
      this.emitted.push({ type, payload });
    }
    return true;
  }
}

const socket = new FakeSocket();
const logLines = [];
attachStrategy(socket, {
  room: 'replay',
  autoReady: false,
  actionDelayMs: 0,
  heartbeatIntervalMs: 0,
  log: (message) => logLines.push(message),
});

// player_ids：自己放 playerId-1，其余座位占位（kills 由出局推断合成）。
const playerIds = [];
for (let i = 0; i < 8; i += 1) {
  playerIds.push(i === playerId - 1 ? clientId : `other-${i}`);
}

socket.listeners('set_id').forEach((fn) => fn(clientId));
socket.listeners('init_map').forEach((fn) => fn({ n, m, player_ids: playerIds, general: [-1, -1] }));

/* ---------- 引擎队列执行模拟（wire 编码） ---------- */
function ownerOf(code) {
  return typeof code === 'number' && code < 200 ? code % 50 : 0;
}

/** computePush 的 wire 版（无组队对局：队友项不出现）。 */
function simPush(frame, from, to, mode) {
  const totalArmy = frame.army_cnt[from] || 0;
  const cap = Math.max(0, totalArmy - 1);
  if (mode === 2) {
    return cap;
  }
  const fx = Math.floor(from / m);
  const fy = from % m;
  const tx = Math.floor(to / m);
  const ty = to % m;
  let defense = 0;
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    const nx = fx + dx;
    const ny = fy + dy;
    if (nx === tx && ny === ty) {
      continue;
    }
    if (nx < 0 || ny < 0 || nx >= n || ny >= m) {
      continue;
    }
    const nIdx = nx * m + ny;
    const code = frame.grid_type[nIdx];
    if (code === 201) {
      continue;
    }
    if (ownerOf(code) === playerId) {
      continue;
    }
    defense += (frame.army_cnt[nIdx] || 0) - 1;
  }
  const theoretical = Math.max(0, totalArmy - defense - 1);
  return Math.min(mode === 1 ? Math.floor(theoretical / 2) : theoretical, cap);
}

/** 队首 op 对给定帧是否可执行（chkMove + attack>0 / chkBuildCity / chkUpgradeCrown）。 */
function opValid(frame, op) {
  if (op.type === 'build') {
    const { x, y, op: kind } = op.payload;
    const idx = x * m + y;
    const code = frame.grid_type[idx];
    if (ownerOf(code) !== playerId || (frame.isolated[idx] || 0) > 0) {
      return false;
    }
    if ((frame.army_cnt[idx] || 0) < 50) {
      return false;
    }
    if (kind === 'b') {
      return code < 50; // 普通格（wire 编码 0..49）
    }
    return code >= 50 && code < 100; // 指挥所
  }
  const { x, y, dx, dy, mode } = op.payload;
  if (Math.abs(x - dx) + Math.abs(y - dy) !== 1) {
    return false;
  }
  if (dx < 0 || dy < 0 || dx >= n || dy >= m) {
    return false;
  }
  const from = x * m + y;
  const to = dx * m + dy;
  if (ownerOf(frame.grid_type[from]) !== playerId || (frame.isolated[from] || 0) > 0) {
    return false;
  }
  if ((frame.army_cnt[from] || 0) <= 0 || frame.grid_type[to] === 201) {
    return false;
  }
  return simPush(frame, from, to, mode) > 0;
}

/* ---------- 工具 ---------- */
function printBoard(frame) {
  const { grid_type: gt, army_cnt: ac } = frame;
  console.log(`    ${[...Array(m).keys()].map((y) => String(y % 10)).join('')}`);
  for (let x = 0; x < n; x += 1) {
    const cells = [];
    for (let y = 0; y < m; y += 1) {
      const idx = x * m + y;
      const code = gt[idx];
      if (code === 201) {
        cells.push('#');
      } else if (code === 204 || (code >= 150 && code < 200)) {
        cells.push('~');
      } else {
        const owner = ownerOf(code);
        let ch = owner === 0 ? '.' : String.fromCharCode(64 + owner);
        if (code >= 100 && code < 150) {
          ch = owner === 0 ? 'C' : ch.toLowerCase(); // 主城小写
        }
        cells.push(ch);
      }
    }
    console.log(`${String(x).padStart(3)} ${cells.join('')}`);
  }
  const parts = [];
  for (let idx = 0; idx < total; idx += 1) {
    if (ac[idx] > 0 || ownerOf(gt[idx]) > 0) {
      parts.push(`(${Math.floor(idx / m)},${idx % m})=${ac[idx]}`);
    }
  }
  console.log(`army: ${parts.join(' ')}`);
}

/** 用 frames 重建一个 probe ctx（无跨 tick 计划状态，足够回答格子级问题）。 */
function makeProbeCtx(frame) {
  const state = {
    n,
    m,
    gridType: frame.grid_type,
    armyCnt: frame.army_cnt,
    isolated: frame.isolated,
    playerId,
    turn: frame.turn,
    teams: new Map(),
    allowTeam: false,
    deadPlayers: new Set(),
    enemyMenace: new Map(),
  };
  return buildContext(state);
}

function explainCell(x, y, turn, frameByTurn) {
  const frame = frameByTurn.get(turn);
  if (!frame) {
    console.log(`cell (${x},${y})@${turn}: 无该 turn 帧`);
    return;
  }
  const ctx = makeProbeCtx(frame);
  const idx = x * m + y;
  console.log(`--- cell (${x},${y}) idx=${idx} @turn ${turn} ---`);
  console.log(
    `kind=${ctx.tileKind(idx)} owner=${ctx.ownerAt(idx)} army=${ctx.army(idx)} isolated=${ctx.isolatedAt(idx)} ` +
      `operable=${ctx.operable(idx)} keepAt=${ctx.keepAt(idx)} garrisonAt=${ctx.garrisonAt(idx)} ` +
      `frontierDist=${ctx.frontierDist()[idx]} anchorDistMine=${ctx.anchorDistMine()[idx]} danger=${ctx.dangerField()[idx]}`,
  );
  for (const nb of ctx.neighbors(idx)) {
    const p0 = ctx.previewPush(idx, nb, 0);
    const p2 = ctx.previewPush(idx, nb, 2);
    console.log(
      `  nb (${Math.floor(nb / m)},${nb % m}) kind=${ctx.tileKind(nb)} owner=${ctx.ownerAt(nb)} army=${ctx.army(nb)} ` +
        `aliveEnemy=${ctx.isAliveEnemyIdx(nb)} passable=${ctx.passable(nb)} pushMode0=${p0} pushMode2=${p2}`,
    );
  }
}

/* ---------- 主循环 ---------- */
const frameByTurn = new Map(frames.map((f) => [f.turn, f]));
const issued = []; // {turn, line} 复现的 bot 日志
let serverQueue = []; // 服务端队列模拟
const crownOwnersPrev = new Set();
const deadOwners = new Set();

for (const frame of frames) {
  const turn = frame.turn;

  // 出局推断：曾经有冠、现在无冠 → 判死（引擎语义：失最后主城即出局）。
  const crownOwners = new Set();
  for (let idx = 0; idx < total; idx += 1) {
    const code = frame.grid_type[idx];
    if (code >= 100 && code < 150) {
      crownOwners.add(code - 100);
    }
  }
  for (const owner of crownOwnersPrev) {
    if (!crownOwners.has(owner) && owner > 0 && owner !== playerId) {
      deadOwners.add(owner);
    }
  }
  crownOwnersPrev.clear();
  for (const o of crownOwners) {
    crownOwnersPrev.add(o);
  }
  const kills = {};
  for (const owner of deadOwners) {
    kills[playerIds[owner - 1] || `other-${owner - 1}`] = 'replay';
  }

  // 服务端 tick：弹出队首直到一条 op 校验通过（帧后状态近似执行前状态）。
  let skipped = 0;
  let executed = false;
  while (serverQueue.length > 0) {
    const op = serverQueue.shift();
    if (opValid(frame, op)) {
      executed = true;
      break;
    }
    skipped += 1;
  }
  const lstMove = { x: executed ? 0 : -1, skip: skipped };

  socket.emitted = [];
  socket.listeners('update').forEach((fn) =>
    fn({
      is_diff: false,
      grid_type: frame.grid_type,
      army_cnt: frame.army_cnt,
      isolated: frame.isolated,
      turn,
      kills,
      lst_move: lstMove,
      game_end: false,
    }),
  );
  // 等 strategy 的 setTimeout(0) 入队完成。
  await new Promise((resolve) => setTimeout(resolve, 1));

  for (const e of socket.emitted) {
    if (e.type === 'clear_queue') {
      serverQueue = [];
    } else {
      serverQueue.push(e);
    }
  }

  for (const line of logLines) {
    if (line.startsWith(`turn ${turn}:`)) {
      issued.push({ turn, line });
    }
  }
  logLines.length = 0;

  if (turn >= args.from && turn <= args.to) {
    for (const e of socket.emitted) {
      if (e.type === 'attack') {
        const p = e.payload;
        console.log(`turn ${turn}: EMIT attack (${p.x},${p.y})->(${p.dx},${p.dy}) mode=${p.mode}`);
      } else if (e.type === 'build') {
        const p = e.payload;
        console.log(`turn ${turn}: EMIT build ${p.op} @(${p.x},${p.y})`);
      } else {
        console.log(`turn ${turn}: EMIT clear_queue`);
      }
    }
  }
  if (args.boards.has(turn)) {
    console.log(`=== board @turn ${turn} ===`);
    printBoard(frame);
  }
  for (const c of args.cells) {
    if (c.turn === turn) {
      explainCell(c.x, c.y, turn, frameByTurn);
    }
  }
}

/* ---------- 保真度校验 ---------- */
if (args.validate) {
  const opRe = /turn (\d+): (attack \((\d+),(\d+)\)->\((\d+),(\d+)\) mode=(\d+)|build (\w) @\((\d+),(\d+)\))/;
  const expected = [];
  for (const line of botLog.split('\n')) {
    const match = opRe.exec(line);
    if (match) {
      expected.push(`${match[1]} ${match[2]}`);
    }
  }
  const actual = [];
  for (const { line } of issued) {
    const match = opRe.exec(line);
    if (match) {
      actual.push(`${match[1]} ${match[2]}`);
    }
  }
  const maxLen = Math.max(expected.length, actual.length);
  let firstDiff = -1;
  let same = 0;
  for (let i = 0; i < maxLen; i += 1) {
    if (expected[i] === actual[i]) {
      same += 1;
    } else if (firstDiff < 0) {
      firstDiff = i;
    }
  }
  console.log(`校验：期望 ${expected.length} 条 op，复现 ${actual.length} 条，逐位一致 ${same} 条`);
  if (firstDiff >= 0) {
    console.log(`首个分歧 @#${firstDiff}: 期望[${expected[firstDiff]}] 实际[${actual[firstDiff]}]`);
    console.log(`期望上下文: ${expected.slice(Math.max(0, firstDiff - 3), firstDiff + 3).join(' | ')}`);
    console.log(`实际上下文: ${actual.slice(Math.max(0, firstDiff - 3), firstDiff + 3).join(' | ')}`);
  }
}
