// 断线重连换绑 init_map 同步回归：换绑补发必须携带 next_seq/queue_ops 且与服务端当前状态一致，
// 否则两端 seq 永久错位（lst_moves 摘不到队列项，箭头/建造标志永不消失）。失败返回非零。
import { GameEngine } from '../dist/game-engine.js';

const base = {
  width_ratio: 0.5,
  height_ratio: 0.5,
  city_ratio: 0,
  mountain_ratio: 0,
  swamp_ratio: 0,
  speed: 1,
  allow_team: false,
  fog: false,
  multi_line: true,
  map_token: 'rebind-sync',
  map_mode: 'random',
  map_region: 'china',
  map_size: 'normal',
  player_names: ['A', 'B'],
  player_teams: [1, 2],
};
let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) {
    failures++;
    console.error(`失败: ${name}${detail ? ` (${detail})` : ''}`);
  } else console.log(`通过: ${name}`);
}

const inits = [];
const cb = {
  update: () => {},
  emitInitMap: (sid, data) => inits.push({ sid, data }),
  chatMessage: () => {},
  endGame: () => {},
  disciplineEvent: () => {},
  md5: (x) => x,
  replayStore: { saveReplay: async () => '' },
};
const e = await GameEngine.create(base, ['a', 'b'], ['a', 'b'], `rebind-${Math.random()}`, cb);
e.enableAfkSurrender = false;

// 开局路径基线：init_map 已带 seq 同步字段。
const startInit = inits.find((x) => x.sid === 'a')?.data;
check('开局 init_map 带 next_seq=1', startInit?.next_seq === 1);
check(
  '开局 init_map 带空 queue_ops',
  Array.isArray(startInit?.queue_ops) && startInit.queue_ops.length === 0,
);

// 入队若干条指令，推进服务端 nextSeq。
e.addMove('a', 0, 0, 0, 1);
e.addMove('a', 0, 1, 0, 2);
e.addBuild('a', 1, 1, 'b');
const expectedNext = e['nextSeq'][0];
check('入队 3 条后服务端 nextSeq=4', expectedNext === 4, `nextSeq=${expectedNext}`);
check('换绑前服务端队列有 3 条', e['pmove'][0].length === 3);

// 触发断线重连换绑路径。
inits.length = 0;
const ok = e.rebindPlayer('a', 'a2');
check('rebindPlayer 换绑成功', ok === true);
const rebindInit = inits.find((x) => x.sid === 'a2')?.data;
check('换绑路径补发 init_map', Boolean(rebindInit));
check(
  '换绑 init_map 带 next_seq 且与服务端当前值一致',
  rebindInit?.next_seq === expectedNext,
  `next_seq=${rebindInit?.next_seq}, 期望=${expectedNext}`,
);
check('换绑 init_map 带 queue_ops 数组', Array.isArray(rebindInit?.queue_ops));
check(
  '换绑 queue_ops 与换绑清队后的服务端队列一致（空拷贝）',
  Array.isArray(rebindInit?.queue_ops) && rebindInit.queue_ops.length === 0 && e['pmove'][0].length === 0,
);

// 换绑后服务端 seq 不复位，新入队指令接续递增（客户端用补发的 next_seq 继续计数即可对齐）。
e.addMove('a2', 2, 2, 2, 3);
check('换绑后入队 seq 接续递增', e['pmove'][0][0]?.seq === expectedNext, `seq=${e['pmove'][0][0]?.seq}`);

// 观战席基线：观战者无自身队列，init_map 不携带 seq 同步字段（客户端观战渲染不依赖）。
inits.length = 0;
e.addSpectator('spec1');
const specInit = inits.find((x) => x.sid === 'spec1')?.data;
check(
  '观战席 init_map 带空队列同步字段',
  specInit?.next_seq === 1 && Array.isArray(specInit?.queue_ops) && specInit.queue_ops.length === 0,
);

if (failures) process.exit(1);
console.log('test-rebind-init-sync: 换绑重连 init_map 同步场景全部通过');
