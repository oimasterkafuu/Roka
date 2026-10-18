// v3 全局队列行为测试：每个场景独立断言，失败返回非零。
import { GameEngine } from '../dist/game-engine.js';

const base = { width_ratio: .5, height_ratio: .5, city_ratio: 0, mountain_ratio: 0, swamp_ratio: 0, speed: 1, allow_team: false, fog: false, multi_line: true, map_token: 'queue-v3', map_mode: 'random', map_region: 'china', map_size: 'normal', player_names: ['A', 'B'], player_teams: [1, 2] };
let failures = 0;
function check(name, ok, detail = '') { if (!ok) { failures++; console.error(`失败: ${name}${detail ? ` (${detail})` : ''}`); } else console.log(`通过: ${name}`); }
async function make() {
  const frames = [], inits = [];
  const cb = { update: (sid, data) => frames.push({ sid, data }), emitInitMap: (sid, data) => inits.push({ sid, data }), chatMessage: () => {}, endGame: () => {}, disciplineEvent: () => {}, md5: x => x, replayStore: { saveReplay: async () => '' } };
  const e = await GameEngine.create(base, ['a', 'b'], ['a', 'b'], `queue-${Math.random()}`, cb);
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
  const c = await make();
  c.e.addMove('a', 0, 0, 0, 1); c.e.addMove('a', 0, 1, 0, 2); c.e.addMove('a', 0, 2, 0, 3);
  await tick(c); c.e.__seen = true; check('单链第 1 Tick 只推进一步', c.e.__attacks.length === 1 && c.e.pmove[0].length === 2);
  await tick(c); check('单链第 2 Tick 只推进一步', c.e.__attacks.length === 2 && c.e.pmove[0].length === 1);
  await tick(c); check('单链第 3 Tick 排空且节奏稳定', c.e.__attacks.length === 3 && c.e.pmove[0].length === 0);
  check('单链每 Tick lst_moves 只含对应 seq', c.e.__seen === true);
}

{
  const c = await make();
  c.e.addMove('a', 0, 0, 0, 1); c.e.addMove('a', 2, 0, 2, 1);
  const frame = await tick(c);
  check('两条独立链同 Tick 并行', c.e.__attacks.length === 2 && c.e.pmove[0].length === 0);
  check('并行两条 seq 同帧汇报', frame.lst_moves.length === 2 && frame.lst_moves.includes(1) && frame.lst_moves.includes(2));
}

{
  const c = await make();
  c.e.addBuild('a', 1, 1, 'b'); c.e.addBuild('a', 1, 1, 'c');
  const frame = await tick(c);
  check('同格 b+c 按序执行', c.e.pmove[0].length === 0 && frame.lst_moves.join(',') === '1,2');
}

{
  const c = await make();
  c.e.chkMove = (x) => x !== 9;
  c.e.addMove('a', 9, 9, 9, 10); c.e.addMove('a', 0, 0, 0, 1);
  const frame = await tick(c);
  check('失效移动被丢弃', c.e.pmove[0].length === 0 && c.e.__attacks.length === 1);
  check('失效 seq 出现在 lst_moves', frame.lst_moves.includes(1) && frame.lst_moves.includes(2));
}

{
  const c = await make();
  c.e.addMove('a', 0, 0, 0, 1); c.e.addBuild('a', 1, 1, 'b');
  const init = c.inits.find(x => x.sid === 'a')?.data;
  check('init_map 下发 next_seq', init?.next_seq === 1);
  check('init_map 下发 queue_ops 字段', Array.isArray(init?.queue_ops) && init.queue_ops.length === 0);
  const frame = await tick(c);
  check('入队操作 seq 单调递增', frame.lst_moves.join(',') === '1,2');
}

if (failures) process.exit(1);
console.log('test-multiline-v2: 全部 v3 全局队列场景通过');
