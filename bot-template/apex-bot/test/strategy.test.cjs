'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { attachStrategy } = require('../strategy.js');
class MockSocket {
  constructor() { this.connected = false; this.events = new Map(); this.sent = []; }
  on(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); }
  off(name, fn) { this.events.get(name)?.delete(fn); }
  emit(name, payload) { this.sent.push([name, payload]); }
  fire(name, payload) { for (const fn of this.events.get(name) || []) fn(payload); }
}
test('strategy validates full/diff frames, readiness protocol, and stop clears timers/listeners', () => {
  const socket = new MockSocket(); const handle = attachStrategy(socket, { room: 'r', heartbeatIntervalMs: 0, actionDelayMs: 0 });
  socket.fire('set_id', 'p0'); socket.fire('room_update', { players: [{ sid: 'p0', ready: false }] });
  assert.deepEqual(socket.sent[0], ['change_ready', { ready: true }]);
  socket.fire('init_map', { n: 1, m: 2, player_ids: ['p0', 'p1'] });
  socket.fire('update', { turn: 0, is_diff: false, grid_type: [101, 2], army_cnt: [2, 1], isolated: [0, 0], fog: [0, 0], leaderboard: [{ id: 1, team: 1 }] });
  assert.equal(handle.state.turn, 0); assert.equal(handle.state.grid[0], 101);
  socket.fire('update', { turn: 1, is_diff: true, grid_type: [1, 200], army_cnt: [1, 4], isolated: [0, 0], fog: [1, 1] });
  assert.equal(handle.state.grid[1], 200); assert.equal(handle.state.fog[1], 1);
  socket.fire('update', { turn: 2, is_diff: true, grid_type: [1] });
  assert.equal(handle.state.turn, 1);
  handle.stop(); socket.fire('room_kick'); socket.fire('update', { turn: 3, is_diff: false, grid_type: [101, 2], army_cnt: [2, 1] });
  assert.equal(handle.state.turn, 1);
});
