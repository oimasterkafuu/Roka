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
  command(s, '/ready'); b.tick(); b.tick(); assert.deepEqual(s.sent, [['change_team', { team: 1 }]]);
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
