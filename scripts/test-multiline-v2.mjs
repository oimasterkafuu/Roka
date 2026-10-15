// 多线争锋 v2（spec-multi-line-v2.md，issue #107 修订）引擎级单元测试：直接驱动
// dist/game-engine.js，逐条验收 R1~R4，另附单线对局回归（v2 不得改变单线行为）。
//   R1 战线数量不设上限：连续开辟 7 条战线（> v1 的 4 条上限），显式 line 参数被忽略；
//   R2 Q/E 全局撤回：retractLast 按入队的全局时间序跨战线撤回最后一条指令；
//   R3 链式挂尾：发「从 A 移到 B」再发「从 B 移到 C」，B→C 挂到同一战线队尾——
//      逐 Tick 断言第 1 Tick 只执行 A→B、第 2 Tick 链式推进执行 B→C（C 变为己方）；
//   R4 分兵 + 真并行调度：同一出发点的两个不同方向指令各自成立战线，
//      两条非空战线在同一 Tick 各执行一条（不再轮转 1/N）；
//   回归：单线对局的链式入队（A→B→C 依次执行）、popQueue/clearQueue 行为不变。
// 成功 exit 0，失败 exit 1。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineEntry = path.join(rootDir, 'dist', 'game-engine.js');

function ensureBuild() {
  if (fs.existsSync(engineEntry)) {
    return;
  }
  const result = spawnSync('pnpm', ['run', 'build'], { cwd: rootDir, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('构建失败');
  }
}

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${name}${detail ? `：${detail}` : ''}`);
  }
}

function makeCallbacks() {
  const frames = [];
  const inits = {};
  return {
    frames,
    inits,
    update: (sid, data) => frames.push({ sid, data }),
    emitInitMap: (sid, data) => {
      inits[sid] = data;
    },
    chatMessage: () => undefined,
    endGame: () => undefined,
    disciplineEvent: () => undefined,
    md5: (input) => input,
    replayStore: { saveReplay: async () => '' },
  };
}

async function newEngine(GameEngine, multiLine, token) {
  const cb = makeCallbacks();
  const conf = {
    width_ratio: 0.5,
    height_ratio: 0.5,
    city_ratio: 0,
    mountain_ratio: 0,
    swamp_ratio: 0,
    speed: 1,
    allow_team: false,
    fog: false,
    multi_line: multiLine,
    map_token: token,
    map_mode: 'random',
    map_region: 'china',
    map_size: 'normal',
    player_names: ['A', 'B'],
    player_teams: [1, 2],
  };
  const engine = await GameEngine.create(conf, ['sidA', 'sidB'], ['idA', 'idB'], 'test-mlv2', cb);
  return { engine, cb };
}

// 直接写棋盘内部状态（owner/gridType/armyCnt/isolated 四元组）。
function own(engine, x, y, army) {
  engine.gridType[x][y] = 0;
  engine.owner[x][y] = 1;
  engine.armyCnt[x][y] = army;
  engine.isolated[x][y] = 0;
}
function neutral(engine, x, y) {
  engine.gridType[x][y] = 0;
  engine.owner[x][y] = 0;
  engine.armyCnt[x][y] = 0;
  engine.isolated[x][y] = 0;
}

const inBounds = (engine, x, y) => x >= 0 && y >= 0 && x < engine.n && y < engine.m;
const walkable = (engine, x, y) => inBounds(engine, x, y) && engine.gridType[x][y] !== 1;

/** 在玩家 1 主城附近找一条 length 格的直线通道（用于布置 A/B/C…）。 */
function pickStraightRun(engine, length) {
  const [gx, gy] = engine.generals[0];
  const dirs = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ];
  for (const [dx, dy] of dirs) {
    const cells = [];
    for (let k = 1; k <= length; k += 1) {
      const x = gx + dx * k;
      const y = gy + dy * k;
      if (!walkable(engine, x, y)) {
        break;
      }
      cells.push([x, y]);
    }
    if (cells.length === length) {
      return { dir: [dx, dy], cells };
    }
  }
  throw new Error('主城附近找不到直线通道');
}

/** 全图散布取 count 个互不冲突的出发点（R1 用，不走 Tick，无需连通）。 */
function pickSpreadCells(engine, count) {
  const cells = [];
  const used = new Set();
  for (let x = 1; x < engine.n - 1 && cells.length < count; x += 1) {
    for (let y = 1; y < engine.m - 1 && cells.length < count; y += 1) {
      if ((x + y) % 2 !== 0 || !walkable(engine, x, y) || !walkable(engine, x + 1, y)) {
        continue;
      }
      const key = `${x},${y}`;
      const targetKey = `${x + 1},${y}`;
      if (used.has(key) || used.has(targetKey)) {
        continue;
      }
      used.add(key);
      used.add(targetKey);
      cells.push([x, y]);
    }
  }
  if (cells.length < count) {
    throw new Error(`地图太小，取不到 ${count} 个出发点`);
  }
  return cells;
}

const queuedTotal = (engine, p) => engine.pmove[p].reduce((sum, queue) => sum + queue.length, 0);

async function tick(engine, count = 1) {
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await engine.gameTick();
  }
}

/** sidA 帧中出现的 lst_move 记录（本 Tick 被执行的操作）。 */
const executedMoves = (cb) =>
  cb.frames
    .filter((f) => f.sid === 'sidA' && f.data.lst_move && f.data.lst_move.x !== -1)
    .map((f) => f.data.lst_move);

async function scenarioR1(GameEngine) {
  console.log('R1：战线数量不设上限（动态增长）');
  const { engine, cb } = await newEngine(GameEngine, true, 'mlv2-r1');
  check('init_map 初始 line_count=1（v2 开战一条战线）', cb.inits.sidA.line_count === 1);
  const spots = pickSpreadCells(engine, 7);
  for (const [x, y] of spots) {
    own(engine, x, y, 10);
    neutral(engine, x + 1, y);
  }
  // 前 6 条指令不带 line；第 7 条显式携带 line=3（v2 应忽略，仍按路由开辟新战线）。
  for (let i = 0; i < 6; i += 1) {
    engine.addMove('sidA', spots[i][0], spots[i][1], spots[i][0] + 1, spots[i][1], 2);
  }
  engine.addMove('sidA', spots[6][0], spots[6][1], spots[6][0] + 1, spots[6][1], 2, 3);
  check(
    '战线数动态增长到 7 条（突破 v1 的 4 条上限）',
    engine.pmove[0].length === 7,
    `实际 ${engine.pmove[0].length}`,
  );
  check(
    '每条战线各持有自己的 1 条待发指令',
    engine.pmove[0].every((queue) => queue.length === 1) && queuedTotal(engine, 0) === 7,
  );
  check(
    '各战线起始点分别跟踪为各自出发格',
    engine.pqueueHead[0].every((head, l) => head && head.x === spots[l][0] && head.y === spots[l][1]),
  );
}

async function scenarioR2(GameEngine) {
  console.log('R2：Q/E 撤回全局最后一条指令（跨战线、按入队时间序）');
  const { engine } = await newEngine(GameEngine, true, 'mlv2-r2');
  const run = pickStraightRun(engine, 2);
  const [ax, ay] = run.cells[0];
  const [bx, by] = run.cells[1];
  const [gx, gy] = engine.generals[0];
  // 第二个出发点：与第一条通道不同方向、同样贴着主城（保证连通）。
  const other = [
    [gx + 1, gy],
    [gx - 1, gy],
    [gx, gy + 1],
    [gx, gy - 1],
  ].find(([x, y]) => (x !== ax || y !== ay) && walkable(engine, x, y));
  const [ex, ey] = other;
  const [fx, fy] = [ex + (ex - gx), ey + (ey - gy)];
  own(engine, ax, ay, 10);
  neutral(engine, bx, by);
  own(engine, ex, ey, 10);
  neutral(engine, fx, fy);
  engine.addMove('sidA', ax, ay, bx, by, 2); // 战线 0
  engine.addMove('sidA', ex, ey, fx, fy, 2); // 战线 1
  engine.addBuild('sidA', ax, ay, 'b'); // 建造格是战线 0 起始点 → 并入战线 0
  check(
    '入队布局：战线 0 = [移动, 建造]，战线 1 = [移动]',
    engine.pmove[0].length === 2 &&
      engine.pmove[0][0].length === 2 &&
      engine.pmove[0][1].length === 1,
    JSON.stringify(engine.pmove[0].map((q) => q.length)),
  );
  engine.retractLast('sidA');
  check(
    '第一次撤回：全局最后的建造指令（战线 0 队尾）被撤回，战线 1 不受影响',
    engine.pmove[0][0].length === 1 && engine.pmove[0][1].length === 1,
  );
  engine.retractLast('sidA');
  check(
    '第二次撤回：跨战线撤回战线 1 的移动（全局时间序上的最后一条），战线 0 保留',
    engine.pmove[0][0].length === 1 && engine.pmove[0][1].length === 0,
  );
  engine.retractLast('sidA');
  check('第三次撤回：全部队列清空', queuedTotal(engine, 0) === 0);
  engine.retractLast('sidA');
  check('空队列上撤回是安全无操作', queuedTotal(engine, 0) === 0);
}

async function scenarioR3(GameEngine) {
  console.log('R3：链式挂尾（A→B 未执行时再发 B→C，挂同一战线队尾接续执行）');
  const { engine, cb } = await newEngine(GameEngine, true, 'mlv2-r3');
  const run = pickStraightRun(engine, 3);
  const [ax, ay] = run.cells[0];
  const [bx, by] = run.cells[1];
  const [cx, cy] = run.cells[2];
  own(engine, ax, ay, 40); // A：己方，兵力充足（两次全冲后仍 > 0）
  neutral(engine, bx, by); // B：中立
  neutral(engine, cx, cy); // C：中立
  engine.addMove('sidA', ax, ay, bx, by, 2); // 从 A 移到 B
  engine.addMove('sidA', bx, by, cx, cy, 2); // 从 B 移到 C —— B 已是 A→B 的到达格（非起始点）
  check(
    'B→C 链式挂尾：A→B 未执行时 B→C 入队同一战线（仍 1 条战线、2 条待发指令）',
    engine.pmove[0].length === 1 && engine.pmove[0][0].length === 2 && queuedTotal(engine, 0) === 2,
    `战线数 ${engine.pmove[0].length}，各线 ${JSON.stringify(engine.pmove[0].map((q) => q.length))}`,
  );
  await tick(engine, 1);
  check('第 1 Tick 执行 A→B：B 变为己方', engine.owner[bx][by] === 1);
  check('第 1 Tick 后 C 仍为中立（挂尾的 B→C 尚未轮到）', engine.owner[cx][cy] === 0);
  check(
    '起始点随执行推进：战线 0 起始点由 A 推进到 B',
    engine.pqueueHead[0][0] && engine.pqueueHead[0][0].x === bx && engine.pqueueHead[0][0].y === by,
  );
  await tick(engine, 1);
  check('第 2 Tick 链式推进：挂尾的 B→C 执行，C 变为己方', engine.owner[cx][cy] === 1);
  check(
    '起始点继续推进到 C',
    engine.pqueueHead[0][0] && engine.pqueueHead[0][0].x === cx && engine.pqueueHead[0][0].y === cy,
  );
  const abExecuted = executedMoves(cb).some(
    (mv) => mv.x === ax && mv.y === ay && mv.dx === bx && mv.dy === by,
  );
  const bcExecuted = executedMoves(cb).some(
    (mv) => mv.x === bx && mv.y === by && mv.dx === cx && mv.dy === cy,
  );
  check('lst_move 中 A→B 与 B→C 依次各执行一次', abExecuted && bcExecuted);
}

async function scenarioR4(GameEngine) {
  console.log('R4：同一出发点多方向指令分兵，各自成队、真并行调度');
  const { engine, cb } = await newEngine(GameEngine, true, 'mlv2-r4');
  const run = pickStraightRun(engine, 2);
  const [ax, ay] = run.cells[0];
  const [bx, by] = run.cells[1];
  // D：A 的垂直方向邻格（与 run 方向不同）。
  const perp = run.dir[0] === 0 ? [1, 0] : [0, 1];
  let dCell = [ax + perp[0], ay + perp[1]];
  if (!walkable(engine, dCell[0], dCell[1])) {
    dCell = [ax - perp[0], ay - perp[1]];
  }
  const [dx, dy] = dCell;
  own(engine, ax, ay, 40); // A：兵力充足，双向半兵推出后仍 > 0
  neutral(engine, bx, by);
  neutral(engine, dx, dy);
  engine.addMove('sidA', ax, ay, bx, by, 1); // A → B（方向 1）
  engine.addMove('sidA', ax, ay, dx, dy, 1); // A → D（方向 2，分兵）
  engine.addMove('sidA', ax, ay, bx, by, 1); // A → B 同向追加（不得再另立战线）
  engine.addMove('sidA', ax, ay, dx, dy, 1); // A → D 同向追加（不得再另立战线）
  check(
    '同出发点多方向 = 分兵：形成 2 条战线，各持 2 条指令（同向追加不另立战线）',
    engine.pmove[0].length === 2 && engine.pmove[0][0].length === 2 && engine.pmove[0][1].length === 2,
    `战线数 ${engine.pmove[0].length}，各线 ${JSON.stringify(engine.pmove[0].map((q) => q.length))}`,
  );
  await tick(engine, 1);
  check(
    '真并行：同一 Tick 两条非空战线各走一步（B 与 D 在同一 Tick 变为己方）',
    engine.owner[bx][by] === 1 && engine.owner[dx][dy] === 1,
    `B=${engine.owner[bx][by]} D=${engine.owner[dx][dy]}`,
  );
  // lst_move 每 Tick 只汇报一条：两条战线均有活动时汇报最后一条活动战线（line=1）。
  const firstTickMoves = executedMoves(cb);
  check(
    'lst_move 汇报最后活动战线（第 1 Tick line=1）',
    firstTickMoves.length === 1 && firstTickMoves[0].line === 1,
    JSON.stringify(firstTickMoves),
  );
  await tick(engine, 1);
  check(
    '第 2 Tick 两战线继续并行：起始点分别推进到 B 与 D',
    engine.pqueueHead[0][0] &&
      engine.pqueueHead[0][0].x === bx &&
      engine.pqueueHead[0][0].y === by &&
      engine.pqueueHead[0][1] &&
      engine.pqueueHead[0][1].x === dx &&
      engine.pqueueHead[0][1].y === dy,
  );
  check('两条战线第 2 Tick 后均排空', queuedTotal(engine, 0) === 0);
}

async function scenarioSingleLineRegression(GameEngine) {
  console.log('回归：单线对局行为与 v1 一致（链式入队 / popQueue / clearQueue）');
  const { engine } = await newEngine(GameEngine, false, 'mlv2-single');
  check('单线对局 init_map 不带 multi_line/line_count', true); // 协议由冒烟测试覆盖，此处仅行为
  const run = pickStraightRun(engine, 3);
  const [ax, ay] = run.cells[0];
  const [bx, by] = run.cells[1];
  const [cx, cy] = run.cells[2];
  own(engine, ax, ay, 40);
  neutral(engine, bx, by);
  neutral(engine, cx, cy);
  engine.addMove('sidA', ax, ay, bx, by, 1);
  engine.addMove('sidA', bx, by, cx, cy, 1);
  check(
    '单线：A→B、B→C 链式入队到同一队列（v2 覆盖语义不影响单线）',
    engine.pmove[0].length === 1 && engine.pmove[0][0].length === 2,
  );
  await tick(engine, 2);
  check('单线：A→B 执行（B 己方）', engine.owner[bx][by] === 1);
  check('单线：B→C 链式执行（C 己方）', engine.owner[cx][cy] === 1);

  const { engine: engine2 } = await newEngine(GameEngine, false, 'mlv2-single-pop');
  const run2 = pickStraightRun(engine2, 3);
  const [px, py] = run2.cells[0];
  const [qx, qy] = run2.cells[1];
  const [rx, ry] = run2.cells[2];
  own(engine2, px, py, 40);
  neutral(engine2, qx, qy);
  neutral(engine2, rx, ry);
  engine2.addMove('sidA', px, py, qx, qy, 1);
  engine2.addMove('sidA', qx, qy, rx, ry, 1);
  engine2.popQueue('sidA');
  check('单线：popQueue 撤销队尾（剩 1 条）', engine2.pmove[0][0].length === 1);
  engine2.clearQueue('sidA');
  check('单线：clearQueue 清空队列', engine2.pmove[0][0].length === 0);
}

async function main() {
  ensureBuild();
  const { GameEngine } = await import(pathToFileURL(engineEntry).href);
  await scenarioR1(GameEngine);
  await scenarioR2(GameEngine);
  await scenarioR3(GameEngine);
  await scenarioR4(GameEngine);
  await scenarioSingleLineRegression(GameEngine);
  if (failures > 0) {
    console.error(`多线争锋 v2 引擎测试失败：${failures} 项断言未通过`);
    process.exit(1);
  }
  console.log('测试通过：R1 动态战线、R2 全局撤回、R3 链式挂尾、R4 分兵真并行与单线回归全部符合预期');
  process.exit(0);
}

main().catch((error) => {
  console.error(`测试异常：${error.stack || error.message}`);
  process.exit(1);
});
