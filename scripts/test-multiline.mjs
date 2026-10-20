// 单线串行（multi_line: false）行为测试：每个场景独立断言，失败返回非零。
import { GameEngine } from '../dist/game-engine.js';

const base = { width_ratio: .5, height_ratio: .5, city_ratio: 0, mountain_ratio: 0, swamp_ratio: 0, speed: 1, allow_team: false, fog: false, multi_line: false, map_token: 'queue-single', map_mode: 'random', map_region: 'china', map_size: 'normal', player_names: ['A', 'B'], player_teams: [1, 2] };
let failures = 0;
function check(name, ok, detail = '') { if (!ok) { failures++; console.error(`失败: ${name}${detail ? ` (${detail})` : ''}`); } else console.log(`通过: ${name}`); }
async function make() {
  const frames = [], inits = [];
  const cb = { update: (sid, data) => frames.push({ sid, data }), emitInitMap: (sid, data) => inits.push({ sid, data }), chatMessage: () => {}, endGame: () => {}, disciplineEvent: () => {}, md5: x => x, replayStore: { saveReplay: async () => '' } };
  const e = await GameEngine.create(base, ['a', 'b'], ['a', 'b'], `single-${Math.random()}`, cb);
  e.enableAfkSurrender = false;
  e.chkMove = () => true;
  e.attack = (x, y, dx, dy) => { e.__attacks.push(`${x},${y}->${dx},${dy}`); return true; };
  e.chkBuildCity = () => true;
  e.chkUpgradeCrown = () => true;
  e.__attacks = [];
  return { e, frames, inits };
}
async function tick(ctx) { await ctx.e['gameTick'](); return ctx.frames.filter(x => x.sid === 'a').at(-1)?.data || { lst_moves: [] }; }

{
  // 核心断言：同 Tick 从两个不同格子各发一条指令，每 Tick 只执行一条。
  const c = await make();
  c.e.addMove('a', 0, 0, 0, 1); c.e.addMove('a', 2, 0, 2, 1);
  let frame = await tick(c);
  check('两个出发点同 Tick 只执行第一条', c.e.__attacks.length === 1 && c.e.__attacks[0] === '0,0->0,1');
  check('第二条原地等待（不并行）', c.e.pmove[0].length === 1 && c.e.pmove[0][0].seq === 2);
  check('第 1 Tick lst_moves 只含被执行 seq', frame.lst_moves.join(',') === '1');
  frame = await tick(c);
  check('第 2 Tick 执行等待中的第二条', c.e.__attacks.length === 2 && c.e.__attacks[1] === '2,0->2,1');
  check('第 2 Tick 后队列排空', c.e.pmove[0].length === 0 && frame.lst_moves.join(',') === '2');
}

{
  // 单链节奏：每 Tick 推进一步。
  const c = await make();
  c.e.addMove('a', 0, 0, 0, 1); c.e.addMove('a', 0, 1, 0, 2); c.e.addMove('a', 0, 2, 0, 3);
  await tick(c); check('单链第 1 Tick 只推进一步', c.e.__attacks.length === 1 && c.e.pmove[0].length === 2);
  await tick(c); check('单链第 2 Tick 只推进一步', c.e.__attacks.length === 2 && c.e.pmove[0].length === 1);
  const frame = await tick(c);
  check('单链第 3 Tick 排空且节奏稳定', c.e.__attacks.length === 3 && c.e.pmove[0].length === 0);
  check('单链 seq 逐 Tick 顺序汇报', frame.lst_moves.join(',') === '3');
}

{
  // 失效队首被丢弃并继续尝试后续，直到第一条有效指令执行。
  const c = await make();
  c.e.chkMove = (x) => x !== 9;
  c.e.addMove('a', 9, 9, 9, 10); c.e.addMove('a', 0, 0, 0, 1);
  const frame = await tick(c);
  check('失效队首被丢弃且同 Tick 执行下一条', c.e.pmove[0].length === 0 && c.e.__attacks.length === 1);
  check('丢弃 + 执行的 seq 都进 lst_moves', frame.lst_moves.join(',') === '1,2');
}

{
  // 执行首条有效指令后本 Tick 不再处理后续（即使后续已失效也不当场丢弃）。
  const c = await make();
  c.e.chkMove = (x) => x !== 5;
  c.e.addMove('a', 0, 0, 0, 1); c.e.addMove('a', 5, 5, 5, 6);
  let frame = await tick(c);
  check('执行一条后本 Tick 停止调度', c.e.__attacks.length === 1 && frame.lst_moves.join(',') === '1');
  check('后续失效指令原地等待下 Tick', c.e.pmove[0].length === 1 && c.e.pmove[0][0].seq === 2);
  frame = await tick(c);
  check('失效指令在下 Tick 被丢弃', c.e.pmove[0].length === 0 && c.e.__attacks.length === 1 && frame.lst_moves.join(',') === '2');
}

{
  // 建造指令同样单线串行：同格 b+c 每 Tick 只执行一条。
  const c = await make();
  c.e.addBuild('a', 1, 1, 'b'); c.e.addBuild('a', 1, 1, 'c');
  let frame = await tick(c);
  check('建造第 1 Tick 只执行 b', c.e.pmove[0].length === 1 && frame.lst_moves.join(',') === '1');
  frame = await tick(c);
  check('建造第 2 Tick 执行 c', c.e.pmove[0].length === 0 && frame.lst_moves.join(',') === '2');
}

{
  // 撤回（Q/E）摘除大队列队尾。
  const c = await make();
  c.e.addMove('a', 0, 0, 0, 1); c.e.addMove('a', 2, 0, 2, 1);
  c.e.retractLast('a');
  check('撤回摘除队尾指令', c.e.pmove[0].length === 1 && c.e.pmove[0][0].seq === 1);
  const frame = await tick(c);
  check('撤回后剩余指令正常执行', c.e.__attacks.length === 1 && frame.lst_moves.join(',') === '1');
}

{
  // 单线对局 Q 清空整个操作队列（issue #119）。
  const c = await make();
  c.e.addMove('a', 0, 0, 0, 1); c.e.addMove('a', 2, 0, 2, 1); c.e.addBuild('a', 1, 1, 'b');
  c.e.clearQueue('a');
  check('Q 清空全部待发指令', c.e.pmove[0].length === 0);
  const frame = await tick(c);
  check('清空后本 Tick 无任何执行', c.e.__attacks.length === 0 && frame.lst_moves.length === 0);
}

{
  // 协议：单线对局 init_map 保持旧行为（无 multi_line 标记），next_seq/queue_ops 保留。
  const c = await make();
  const init = c.inits.find(x => x.sid === 'a')?.data;
  check('单线 init_map 不下发 multi_line', init && !('multi_line' in init));
  check('init_map 保留 next_seq', init?.next_seq === 1);
  check('init_map 保留 queue_ops 字段', Array.isArray(init?.queue_ops) && init.queue_ops.length === 0);
  c.e.addMove('a', 0, 0, 0, 1);
  const frame = await tick(c);
  check('入队操作 seq 单调递增', frame.lst_moves.join(',') === '1');
}

if (failures) process.exit(1);
console.log('test-multiline: 全部单线串行场景通过');
