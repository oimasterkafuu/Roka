import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { LobbyService } from '../dist/server/lobby-service.js';

let passed = 0;
const io = { emit() {}, to() { return this; } };
function room(humans, ai, humanReady, aiReady, spectators = 0) {
  const lobby = new LobbyService({}, {});
  for (const [kind, total, ready] of [['h', humans, humanReady], ['a', ai, aiReady], ['s', spectators, spectators]]) {
    for (let i = 0; i < total; i++) {
      const sid = `${kind}${i}`;
      if (kind !== 'a') lobby.humanVerified.add(sid);
      lobby.joinLobby(sid, sid, 'test');
      const player = lobby.lobbyPlayers.get('test').find((p) => p.sid === sid);
      player.team = kind === 's' ? 0 : 1;
      player.ready = i < ready;
    }
  }
  return lobby;
}
for (const [h, a, hr, ar, expected] of [
  [3,0,1,0,0], [3,0,2,0,1], [0,3,0,1,0], [0,3,0,2,1],
  [3,1,2,0,0], [3,1,2,1,1], [1,1,1,0,0], [1,1,0,1,0], [1,1,1,1,1],
  [4,0,2,0,1], [0,4,0,2,1], [2,2,1,1,1], [1,0,1,0,0],
  // 两人房全员准备才开局：同类型两人只准备一个不开局
  [2,0,1,0,0], [2,0,2,0,1], [0,2,0,1,0], [0,2,0,2,1],
]) {
  const lobby = room(h,a,hr,ar);
  let starts = 0;
  lobby.startGame = async () => { starts++; };
  lobby.checkReady(io, 'test');
  assert.equal(starts, expected, `${h} humans/${a} AI, ready ${hr}/${ar}`);
  passed++;
}
const mixed = room(3,1,2,0,2);
const payload = mixed.generateRoomConfig('test');
assert.deepEqual(payload.ready_counts, { human: { ready: 2, need: 2, total: 3 }, ai: { ready: 0, need: 1, total: 1 } });
assert.deepEqual(mixed.listLobbyRooms()[0].ready_counts, payload.ready_counts);
assert.equal(payload.ready, 2);
assert.equal(payload.need, 3);
passed++;
const team = room(2,2,1,1);
team.lobbyConfig.get('test').allow_team = true;
team.sendLobbySystemMessage = () => {};
let teamStarts = 0;
team.startGame = async () => { teamStarts++; };
team.checkReady(io, 'test');
assert.equal(teamStarts, 0);
passed++;

// Execute the actual waiting-room rendering branch, capturing DOM writes.
const source = fs.readFileSync('static/main.js', 'utf8');
const rendering = source.slice(source.indexOf('  deploy_queued = Boolean(data.update_queued);'), source.indexOf('  // 检测新玩家进房'));
for (const lobby of [mixed, room(3,0,2,0), room(0,2,0,1)]) {
  const data = lobby.generateRoomConfig('test');
  const nodes = {};
  const $ = (id) => {
    const node = nodes[id] ??= {};
    const chain = {};
    for (const method of ['css','prop','attr','html','text','show','hide']) {
      chain[method] = (...args) => { node[method + (args.length > 1 ? ':' + args[0] : '')] = args.at(-1); return chain; };
    }
    return chain;
  };
  vm.runInNewContext(rendering, { data, $, roomRunning: false, ready_state: 0, refreshDeployBanner() {} });
  assert.equal(nodes['#force-start'].html, '我准备好了');
  const text = nodes['#ready-counts'].text;
  assert.equal(text.includes('真人'), data.ready_counts.human.total > 0);
  assert.equal(text.includes('AI'), data.ready_counts.ai.total > 0);
  for (const group of Object.values(data.ready_counts).filter((g) => g.total)) assert.ok(text.includes(`${group.ready}/${group.need}`));
  passed++;
}
assert.match(fs.readFileSync('static/game.html','utf8'), /id="ready-counts"/);
// Stable three-tier ordering also keeps verified managed bots in the last tier.
const order = room(0,2,0,0);
order.joinLobby('managed', 'managed', 'test', { serverBot: true });
order.humanVerified.add('a1');
order.humanVerified.add('managed');
order.reorderLobbyForVerification('test');
assert.deepEqual(order.lobbyPlayers.get('test').map((p) => p.sid), ['a1','a0','managed']);
order.reorderLobbyForVerification('test');
assert.deepEqual(order.lobbyPlayers.get('test').map((p) => p.sid), ['a1','a0','managed']);
passed++;
console.log(`test-ready-counts: ${passed} regression cases passed`);
