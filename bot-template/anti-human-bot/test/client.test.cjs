'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attachBot } = require('../bot/client.cjs');
class Socket {
  constructor() { this.connected = true; this.handlers = new Map(); this.sent = []; this.disconnects = 0; }
  on(e, h) { this.handlers.set(e, h); }
  off(e) { this.handlers.delete(e); }
  emit(e, p) { this.sent.push([e, p]); }
  receive(e, p) { this.handlers.get(e)?.(p); }
  disconnect() { this.disconnects++; this.connected = false; this.receive('disconnect', 'io client disconnect'); }
  connect() { this.connected = true; this.receive('connect'); }
}
const lobby = (extra = {}) => ({ in_game: false, players: [{ sid: 'me', uid: 'bot', team: 1, ready: false }], need: 2, speed: 1, map_mode: 'fixed', ...extra });
const command = (s, text, extra = {}) => s.receive('chat_message', { sender: 'oimaster', color: 1, text, team: false, ...extra });
const events = (s, event) => s.sent.filter(([e]) => e === event);
function setup(t, options = {}) {
  const s = new Socket(); let time = 0, id = 0; const timers = new Map();
  s.advance = (ms) => { time += ms; };
  const b = attachBot(s, { log: () => {}, now: () => time,
    setInterval: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearInterval: (key) => timers.delete(key), ...options });
  t.after(() => { b.close(); assert.equal(timers.size, 0); assert.equal(s.handlers.size, 0); });
  s.receive('set_id', 'me'); return [s, b, timers];
}
test('连接主动加入指定房间与心跳；注入timer可释放', t => {
  const [s, b, timers] = setup(t); s.receive('connect');
  assert.deepEqual(s.sent, [['join_game_room', { room: 'bot' }], ['room_heartbeat', undefined]]);
  assert.equal(timers.size, 2); [...timers.values()].find(v => v.ms === 30000).fn();
  assert.equal(events(s, 'room_heartbeat').length, 2);
  b.close(); const n = s.sent.length; b.tick(); s.receive('connect'); assert.equal(s.sent.length, n);
});
test('默认不准备且房主/非房主绝不修改配置，不访问map_token', t => {
  const [s, b] = setup(t);
  for (const players of [lobby().players, [{ sid: 'other' }, ...lobby().players]]) {
    const data = lobby({ players }); Object.defineProperty(data, 'map_token', { get() { throw Error('不得读取'); } });
    s.receive('room_update', data); s.advance(60000); b.tick();
  }
  assert.deepEqual(s.sent, []);
  command(s, '/ready'); s.advance(5000); b.tick();
  assert.deepEqual(s.sent, [['change_ready', { ready: true }]]);
});
test('仅服务器提供的oimaster本房间公开消息可控制，文本不能伪造sender', t => {
  const [s, b] = setup(t); s.receive('room_update', lobby());
  for (const text of ['/ready', '/room evil']) {
    for (const extra of [{ sender: 'attacker' }, { sender: 'Oimaster' }, { sender: '' }, { room: 'bot' }, { room: 'elsewhere' }, { team: true }, { color: 0 }]) command(s, text, extra);
    command(s, `oimaster: ${text}`, { sender: 'attacker' });
    command(s, `{"sender":"oimaster","text":"${text}"}`, { sender: 'attacker' });
  }
  s.advance(10000); b.tick(); assert.deepEqual(s.sent, []); assert.equal(s.disconnects, 0);
});
test('/ready开关等待5秒，关闭立即取消，旧等待不会触发且不广播命令', t => {
  const [s, b] = setup(t); s.receive('room_update', lobby()); command(s, '/ready');
  s.advance(4999); b.tick(); assert.equal(s.sent.length, 0);
  s.receive('room_update', lobby()); s.advance(1); b.tick();
  assert.deepEqual(s.sent.at(-1), ['change_ready', { ready: true }]);
  command(s, '/ready'); assert.deepEqual(s.sent.at(-1), ['change_ready', { ready: false }]);
  const n = s.sent.length; s.advance(6000); b.tick(); assert.equal(s.sent.length, n);
  command(s, '/ready'); s.advance(4000); command(s, '/ready'); s.advance(10000); b.tick();
  assert.equal(events(s, 'change_ready').filter(([, p]) => p.ready).length, 1);
  assert.equal(events(s, 'send_message').length, 0);
});
test('每次局间重新等待5秒，游戏中不准备，关闭被拒绝时局外重发取消', t => {
  const [s, b] = setup(t); s.receive('room_update', lobby({ in_game: true })); command(s, '/ready');
  s.advance(10000); b.tick(); assert.equal(s.sent.length, 0);
  s.receive('room_update', lobby()); s.advance(4999); b.tick(); assert.equal(s.sent.length, 0);
  s.advance(1); b.tick(); assert.deepEqual(s.sent.at(-1), ['change_ready', { ready: true }]);
  s.receive('room_update', lobby({ in_game: true })); command(s, '/ready');
  const n = s.sent.length; s.receive('room_update', lobby()); b.tick();
  assert.equal(s.sent.length, n + 1); assert.deepEqual(s.sent.at(-1), ['change_ready', { ready: false }]);
});
test('局外切房通过断开释放席位再join，重连保持目标房间', t => {
  const [s, b] = setup(t); s.receive('room_update', lobby()); command(s, '/room abc');
  assert.equal(s.disconnects, 1); assert.deepEqual(events(s, 'join_game_room'), [['join_game_room', { room: 'abc' }]]);
  s.advance(10000); b.tick(); assert.equal(events(s, 'change_ready').length, 0);
  s.disconnect(); s.connect(); assert.deepEqual(events(s, 'join_game_room').at(-1), ['join_game_room', { room: 'abc' }]);
  assert.equal(events(s, 'leave').length, 0);
});
test('死亡、left、game_end不提前切房，等待服务器局外确认，最后命令优先', t => {
  const [s] = setup(t); s.receive('room_update', lobby({ in_game: true }));
  s.receive('init_map', { n: 1, m: 2, player_ids: ['me'] });
  command(s, '/room abc');
  s.receive('update', { turn: 2, is_diff: false, grid_type: [101, 200], army_cnt: [0, 0], isolated: [0, 0], leaderboard: [{ id: 1, team: 1, dead: 1 }] });
  s.receive('left'); s.receive('room_update', lobby({ in_game: true })); command(s, '/room final');
  assert.equal(s.disconnects, 0);
  s.receive('room_update', lobby()); assert.equal(s.disconnects, 1);
  assert.deepEqual(events(s, 'join_game_room'), [['join_game_room', { room: 'final' }]]);
});
test('game_end仍需room_update(false)确认；未切换期间保留重连原房间', t => {
  const [s] = setup(t); s.receive('room_update', lobby({ in_game: true }));
  s.receive('init_map', { n: 1, m: 2, player_ids: ['me'] }); command(s, '/room abc');
  s.receive('update', { turn: 2, is_diff: false, grid_type: [101, 200], army_cnt: [10, 0], isolated: [0, 0], leaderboard: [{ id: 1, team: 1, dead: 0 }], game_end: true });
  assert.equal(s.disconnects, 0); s.disconnect(); s.connect();
  assert.deepEqual(events(s, 'join_game_room').at(-1), ['join_game_room', { room: 'bot' }]);
  s.receive('room_update', lobby()); assert.deepEqual(events(s, 'join_game_room').at(-1), ['join_game_room', { room: 'abc' }]);
});
test('无效房间命令忽略，当前房间命令取消待切换', t => {
  const [s] = setup(t); s.receive('room_update', lobby({ in_game: true }));
  command(s, '/room abc'); command(s, '/room bot'); s.receive('room_update', lobby());
  for (const text of ['/room', '/room a b', '/room abcdefghijklmnop', '/ready extra']) command(s, text);
  assert.equal(s.disconnects, 0); assert.equal(s.sent.length, 0);
});
test('自动准备开启后观战席先参赛，节流且不更改房间配置，重连重新等待', t => {
  const [s, b] = setup(t); s.receive('room_update', lobby({ players: [{ sid: 'me', team: 0 }] }));
  command(s, '/ready'); b.tick(); b.tick(); assert.deepEqual(s.sent, [['change_team', { team: 2 }]]);
  s.receive('room_update', lobby()); s.advance(5000); b.tick(); b.tick();
  assert.equal(events(s, 'change_ready').length, 1);
  s.disconnect(); s.connect(); s.receive('room_update', lobby());
  s.advance(4999); b.tick(); assert.equal(events(s, 'change_ready').length, 1);
  s.advance(1); b.tick(); assert.equal(events(s, 'change_ready').length, 2);
  assert.equal(events(s, 'change_game_conf').length, 0);
});
test('当前房间取消待切房后恢复准备计时，单人不反复准备', t => {
  const [s, b] = setup(t); s.receive('room_update', lobby({ in_game: true }));
  command(s, '/ready'); command(s, '/room abc'); command(s, '/room bot');
  s.receive('room_update', lobby({ need: 1 })); s.advance(10000); b.tick(); assert.equal(s.sent.length, 0);
  s.receive('room_update', lobby()); b.tick(); assert.deepEqual(s.sent, [['change_ready', { ready: true }]]);
  assert.equal(s.disconnects, 0);
});
test('同tick只发一个操作，结束只返回一次', t => {
  const [s] = setup(t); s.receive('init_map', { n: 1, m: 2, player_ids: ['me'] });
  const p = { turn: 2, is_diff: false, grid_type: [101, 200], army_cnt: [10, 0], isolated: [0, 0], leaderboard: [{ id: 1, team: 1, dead: 0 }] };
  s.receive('update', p); s.receive('update', p); assert.equal(events(s, 'attack').length, 1);
  s.receive('update', { ...p, turn: 3, game_end: true }); s.receive('update', { ...p, turn: 3, game_end: true });
  assert.equal(events(s, 'return_room').length, 1);
});
test('建造走build事件且该tick不再attack', t => {
  const [s] = setup(t); s.receive('init_map', { n: 5, m: 5, player_ids: ['me'] });
  const grid = Array(25).fill(1), army = Array(25).fill(1); grid[0] = 101; army[12] = 112;
  const p = { turn: 80, is_diff: false, grid_type: grid, army_cnt: army, isolated: Array(25).fill(0), leaderboard: [{ id: 1, team: 1, dead: 0 }] };
  s.receive('update', p); s.receive('update', p); assert.deepEqual(s.sent, [['build', { x: 2, y: 2, op: 'b' }]]);
});

test('每帧计算并发送，20turn只限详情打印；汇总可见空动作与真实计算耗时',t=>{
 const logs=[];const [s]=setup(t,{log:x=>logs.push(x)});
 s.receive('init_map',{n:1,m:2,player_ids:['me']});
 for(let turn=100;turn<120;turn++)s.receive('update',{turn,is_diff:false,grid_type:[101,200],army_cnt:[100,0],isolated:[0,0]});
 assert.equal(events(s,'attack').length,20);
 const summary=logs.find(x=>x.startsWith('[决策统计]'));assert.ok(summary);
 assert.match(summary,/计算=20 发送=20 空动作=0/);assert.match(summary,/更新跳号=0/);
 assert.ok(logs.filter(x=>x.startsWith('[决策]')).length<20);
});
test('组队模式人类加入本队时主动避让到无人类队伍，且不再重复换队', t => {
  const [s, b] = setup(t);
  s.receive('room_update', lobby({ allow_team: true, players: [{ sid: 'me', uid: 'bot', team: 2, ready: false, bot: true }] }));
  b.tick(); assert.equal(events(s, 'change_team').length, 0);
  s.receive('room_update', lobby({ allow_team: true, players: [
    { sid: 'me', uid: 'bot', team: 2, ready: false, bot: true },
    { sid: 'h1', uid: 'human', team: 2, ready: false },
  ] }));
  b.tick(); assert.deepEqual(events(s, 'change_team'), [['change_team', { team: 1 }]]);
  // 服务器回显已换到 1 队（无人类）：不再重复发换队，无抖动。
  s.receive('room_update', lobby({ allow_team: true, players: [
    { sid: 'me', uid: 'bot', team: 1, ready: false, bot: true },
    { sid: 'h1', uid: 'human', team: 2, ready: false },
  ] }));
  s.advance(5000); b.tick(); assert.equal(events(s, 'change_team').length, 1);
});
test('避让优先回到首选 2 队；2 队有人类时选最小编号空队，再退纯 bot 队', t => {
  const [s, b] = setup(t);
  // 首选 2 队只有 bot（无人类）：直接回 2 队。
  s.receive('room_update', lobby({ allow_team: true, players: [
    { sid: 'me', uid: 'bot', team: 3, ready: false, bot: true },
    { sid: 'h1', uid: 'human', team: 3, ready: false },
    { sid: 'b2', uid: 'otherbot', team: 2, ready: false, bot: true },
  ] }));
  b.tick(); assert.deepEqual(events(s, 'change_team'), [['change_team', { team: 2 }]]);
  s.sent.length = 0; s.advance(2000);
  // 首选 2 队也有人类：选最小编号空队（1 队）。
  s.receive('room_update', lobby({ allow_team: true, players: [
    { sid: 'me', uid: 'bot', team: 3, ready: false, bot: true },
    { sid: 'h1', uid: 'human', team: 3, ready: false },
    { sid: 'h2', uid: 'human2', team: 2, ready: false },
  ] }));
  b.tick(); assert.deepEqual(events(s, 'change_team'), [['change_team', { team: 1 }]]);
  s.sent.length = 0; s.advance(2000);
  // 16 队全部被占据、只有 4 队是纯 bot：退到纯 bot 队。
  const crowded = [
    { sid: 'me', uid: 'bot', team: 3, ready: false, bot: true },
    { sid: 'h2', uid: 'human2', team: 2, ready: false },
    { sid: 'b2', uid: 'otherbot', team: 4, ready: false, bot: true },
  ];
  for (let team = 1; team <= 16; team++) if (team !== 2 && team !== 4) crowded.push({ sid: `h${team}`, uid: `human${team}`, team, ready: false });
  s.receive('room_update', lobby({ allow_team: true, players: crowded }));
  b.tick(); assert.deepEqual(events(s, 'change_team'), [['change_team', { team: 4 }]]);
});
test('全部队伍都有人类时按兵不动；非组队模式不做避让', t => {
  const [s, b] = setup(t);
  const full = [{ sid: 'me', uid: 'bot', team: 2, ready: false, bot: true }];
  for (let team = 1; team <= 16; team++) full.push({ sid: `h${team}`, uid: `human${team}`, team, ready: false });
  s.receive('room_update', lobby({ allow_team: true, players: full }));
  b.tick(); assert.equal(events(s, 'change_team').length, 0);
  s.receive('room_update', lobby({ players: [
    { sid: 'me', uid: 'bot', team: 1, ready: false, bot: true },
    { sid: 'h1', uid: 'human', team: 1, ready: false },
  ] }));
  s.advance(2000); b.tick(); assert.equal(events(s, 'change_team').length, 0);
});
test('观战席参赛使用自定义 preferredTeam', t => {
  const [s, b] = setup(t, { preferredTeam: 5 });
  s.receive('room_update', lobby({ allow_team: true, players: [{ sid: 'me', uid: 'bot', team: 0, ready: false, bot: true }] }));
  command(s, '/ready'); b.tick(); assert.deepEqual(s.sent, [['change_team', { team: 5 }]]);
});

// 对局内集成：构造 10x10 棋盘帧驱动 update 事件。
// 我方玩家 1（皇冠 101/普通 1/指挥所 51），敌方玩家 2（皇冠 102/普通 2）。
function gameBoard(t, options = {}) {
  const [s] = setup(t, options);
  s.receive('init_map', { n: 10, m: 10, player_ids: ['me', 'foe'] });
  const frame = (turn, cells, lb) => {
    const grid = Array(100).fill(0), army = Array(100).fill(0);
    for (const [i, g, a] of cells) { grid[i] = g; army[i] = a; }
    s.receive('update', { turn, is_diff: false, grid_type: grid, army_cnt: army, isolated: Array(100).fill(0),
      leaderboard: lb ?? [{ id: 1, team: 1, class_: '' }, { id: 2, team: 2, class_: '' }] });
  };
  return [s, frame];
}
const cells = (start, list) => list.map(([g, a], k) => [start + k, g, a]);

test('优势时经 send_message 发垃圾话，且不影响当 tick 操作', t => {
  const [s, frame] = gameBoard(t, { params: { trashTalkChance: 1 } });
  // 我方 40 格 20 兵（800），敌方 10 格 10 兵（100）：碾压
  frame(60, [...cells(0, Array.from({ length: 40 }, () => [1, 20])), ...cells(50, Array.from({ length: 10 }, () => [2, 10]))]);
  const chats = events(s, 'send_message');
  assert.equal(chats.length, 1);
  assert.equal(chats[0][0], 'send_message');
  assert.equal(chats[0][1].team, false);
  assert.ok(typeof chats[0][1].text === 'string' && chats[0][1].text.length > 0);
});

test('绝境四条全满足时先发 GG 再投降，且只投降一次', t => {
  const params = { surrenderMinTurn: 30, surrenderTeaseTicks: 60, surrenderTeaseNearCrownTicks: 5, trashTalk: 0 };
  const [s, frame] = gameBoard(t, { params });
  const layout = (turn) => [
    [11, 101, 30], ...cells(20, [[1, 5], [1, 5], [1, 5], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [1, 5]]),
    [12, 2, 500], // 敌 500 兵贴脸我方皇冠（能收不收）
    ...cells(60, [[102, 500], ...Array.from({ length: 9 }, () => [2, 1000])]),
    ...cells(70, [[102, 500], ...Array.from({ length: 9 }, () => [2, 1000])]),
    ...cells(80, [[102, 500], ...Array.from({ length: 9 }, () => [2, 1000])]),
    ...cells(90, [[102, 500], ...Array.from({ length: 9 }, () => [2, 1000])]),
    [99, turn % 2 ? 2 : 0, turn % 2 ? 10 : 0], // 敌地每 tick 易手 = 活跃
  ];
  for (let turn = 30; turn <= 89; turn++) { frame(turn, layout(turn)); assert.equal(events(s, 'surrender').length, 0); }
  frame(90, layout(90));
  assert.deepEqual(events(s, 'send_message'), [['send_message', { text: 'GG', team: false }]]);
  assert.equal(events(s, 'surrender').length, 1);
  frame(91, layout(91)); // 一击即锁，不重复投降
  assert.equal(events(s, 'surrender').length, 1);
});
