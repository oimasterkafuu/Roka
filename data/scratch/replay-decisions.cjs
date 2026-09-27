// 离线复盘 anti-human-bot 决策：用真实帧驱动当前 policy，逐 turn 记录分支/动作，并与实际操作比对。
// 用法：node data/scratch/replay-decisions.cjs <observeDir> <rplPath> <playerIndex> [fromTurn] [toTurn]
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const v8 = require('v8');

const BOT = '/root/roka/bot-template/anti-human-bot/bot';
const { chooseAction, getDecisionDiagnostics } = require(path.join(BOT, 'policy.cjs'));
const { buildScheduledReplayActions } = require('/root/roka/dist/game-engine/replay-scheduling.js');

const [dir, rplPath, pIdx, fromT, toT] = process.argv.slice(2);
const playerIndex = Number(pIdx);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
const { n, m } = meta;
const ME = playerIndex + 1;

const replay = v8.deserialize(zlib.brotliDecompressSync(fs.readFileSync(rplPath)));
const { scheduledMoves, scheduledBuilds } = buildScheduledReplayActions(replay);

const frames = fs
  .readFileSync(path.join(dir, 'frames.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const teams = {};
meta.playerNames.forEach((_, i) => {
  teams[i + 1] = meta.playerTeams[i];
});

const state = {
  n, m, playerId: ME, teams,
  grid: null, army: null, isolated: null, fog: null,
  turn: -1, ended: false, dead: false, lastMove: null,
};

const from = fromT ? Number(fromT) : 1;
const to = toT ? Number(toT) : meta.totalTurns;
let pendingReceipt = null;
const out = [];

for (const f of frames) {
  if (f.turn < from) continue;
  if (f.turn > to) break;
  state.grid = f.grid_type;
  state.army = f.army_cnt;
  state.isolated = f.isolated || new Array(n * m).fill(0);
  state.fog = null;
  state.turn = f.turn;
  state.lastMove = pendingReceipt;
  pendingReceipt = null;

  const action = chooseAction(state, {});
  const diag = getDecisionDiagnostics(state);
  if (action) {
    if (action.kind === 'build') pendingReceipt = { op: action.op, x: action.x, y: action.y, turn: f.turn + 1 };
    else pendingReceipt = { op: 'm', x: action.x, y: action.y, dx: action.dx, dy: action.dy, turn: f.turn + 1 };
  }
  const actualMove = scheduledMoves[playerIndex].get(f.turn + 1) || null; // 决策帧 t 的命令在 t+1 执行
  const actualBuild = scheduledBuilds[playerIndex].get(f.turn + 1) || null;
  out.push({
    turn: f.turn,
    branch: diag?.branch ?? null,
    consolidating: diag?.consolidating ?? false,
    action: action
      ? action.kind === 'build'
        ? { kind: 'build', op: action.op, x: action.x, y: action.y }
        : { kind: 'attack', x: action.x, y: action.y, dx: action.dx, dy: action.dy, mode: action.mode }
      : null,
    reason: action ? (typeof action.reason === 'string' ? action.reason : JSON.stringify(action.reason)) : null,
    actual: actualMove
      ? { kind: 'attack', x: actualMove[0], y: actualMove[1], dx: actualMove[2], dy: actualMove[3], mode: actualMove[4] }
      : actualBuild
        ? { kind: 'build', op: actualBuild.kind, x: actualBuild.x, y: actualBuild.y }
        : null,
  });
}

const outPath = path.join(dir, `decisions-p${playerIndex}.jsonl`);
fs.writeFileSync(outPath, out.map((r) => JSON.stringify(r)).join('\n') + '\n');

// 汇总
const branchCount = {};
let match = 0, decided = 0, bothAttack = 0;
for (const r of out) {
  branchCount[r.branch || 'null'] = (branchCount[r.branch || 'null'] || 0) + 1;
  if (r.action) decided++;
  if (r.action && r.actual) {
    if (r.action.kind === 'attack' && r.actual.kind === 'attack') {
      bothAttack++;
      if (r.action.x === r.actual.x && r.action.y === r.actual.y && r.action.dx === r.actual.dx && r.action.dy === r.actual.dy) match++;
    } else if (r.action.kind === 'build' && r.actual.kind === 'build') {
      if (r.action.x === r.actual.x && r.action.y === r.actual.y) match++;
    }
  }
}
console.log('分支统计:', JSON.stringify(branchCount, null, 1));
console.log(`决策 ${out.length} tick，出动作 ${decided}；双方同为攻击 ${bothAttack}，位置一致 ${match}`);
console.log('->', outPath);
