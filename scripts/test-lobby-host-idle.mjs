import assert from 'node:assert/strict';
import { LobbyService } from '../src/server/lobby-service.ts';

const LIMIT = 15 * 60_000;
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
function harness() {
  const events = [];
  const io = {
    sockets: { sockets: new Map() },
    to(target) {
      return {
        emit(event, data) {
          events.push({ target, event, data });
        },
      };
    },
    except() {
      return this;
    },
    emit() {},
  };
  const service = new LobbyService({ saveReplay: async () => 'test' }, {});
  service.applyGameResult = async () => {};
  const join = (sid, options) => service.joinLobby(sid, sid, 'room', options);
  const sweep = () => {
    // Live browser tabs keep sending mechanical heartbeats.
    for (const sid of service.lobbyOfSid.keys()) service.recordLobbyHeartbeat(sid);
    service.sweepInactiveLobbyMembers(io);
  };
  return { service, io, events, join, sweep };
}
try {
  {
    const { service: s, join, sweep, events } = harness();
    join('host');
    join('spectator');
    s.lobbyPlayers.get('room')[1].team = 0;
    now += LIMIT - 1;
    sweep();
    assert.equal(s.lobbyPlayers.get('room')[0].sid, 'host');
    now++;
    sweep();
    assert.equal(s.hasLobbyMember('host'), false);
    assert.equal(s.lobbyHeartbeats.has('host'), false);
    assert.equal(s.lobbyJoinedAt.has('host'), false);
    assert.equal(s.lobbyPlayers.get('room')[0].sid, 'spectator');
    assert.match(events.find((e) => e.event === 'room_kick').data.reason, /15 分钟/);
    assert.equal(s.lobbyHostActivity.get('room').sinceMs, now);
    now += LIMIT - 1;
    sweep();
    assert.equal(s.hasLobbyMember('spectator'), true, 'new host gets a full period');
    now++;
    sweep();
    assert.equal(s.lobbyHostActivity.has('room'), false);
    assert.equal(s.listLobbyRooms().length, 0, 'vacant room disappears');
  }
  {
    const { service: s, join, sweep, io } = harness();
    join('host');
    join('observer');
    s.lobbyPlayers.get('room')[1].team = 0;
    now += LIMIT - 1;
    s.recordLobbyActivity('host');
    now++;
    sweep();
    assert.equal(s.hasLobbyMember('host'), true, 'activity renews host period');
    now += LIMIT - 1;
    s.recordLobbyActivity('observer');
    sweep();
    assert.equal(s.hasLobbyMember('host'), false, 'other users cannot renew host');
    s.checkLeave(io, 'observer', () => {}, 'observer');
    assert.equal(s.lobbyHostActivity.has('room'), false, 'leave clears deadline');
    join('observer');
    assert.equal(s.lobbyHostActivity.get('room').sinceMs, now, 'reentry starts fresh');
    s.recordLobbyActivity('not-a-member');
    assert.equal(s.lobbyHostActivity.size, 1);
  }
  {
    const { service: s, join, sweep } = harness();
    join('ai');
    join('human');
    now += LIMIT - 1;
    s.humanVerified.add('human');
    s.reorderLobbyForVerification('room', 'human');
    assert.equal(s.lobbyHostActivity.get('room').sid, 'human');
    now++;
    sweep();
    assert.equal(s.hasLobbyMember('human'), true, 'verification migration starts fresh');
  }
  {
    const { service: s, join, sweep } = harness();
    join('managed', { serverBot: true });
    now += LIMIT * 2;
    sweep();
    assert.equal(s.hasLobbyMember('managed'), true, 'managed bot stays available');
    join('token', { bot: true });
    s.heartbeatExempt.add('token');
    now += LIMIT;
    sweep();
    assert.equal(s.hasLobbyMember('token'), false, 'token heartbeat exemption cannot occupy host forever');
    assert.equal(s.hasLobbyMember('managed'), true);
  }
  {
    const { service: s, join, sweep, io } = harness();
    join('host');
    join('opponent');
    join('observer');
    s.lobbyPlayers.get('room')[2].team = 0;
    await s.startGame(io, 'room');
    const gameId = s.getLobbyVal('room');
    const game = s.gameInstances.get(gameId);
    try {
      assert.equal(s.lobbyHostActivity.has('room'), false, 'start discards waiting deadline');
      now += LIMIT * 2;
      sweep();
      assert.equal(s.hasLobbyMember('host'), true, 'real running game exempt');
      assert.equal(s.hasLobbyMember('observer'), true, 'real spectator exempt');
      s.checkLeave(io, 'host', () => {}, 'host');
      assert.equal(s.tryRejoin(io, 'new-host', 'host', 'room'), true, 'real engine rebind');
      assert.equal(s.lobbyHostActivity.has('room'), false, 'rebind leaves no old deadline');
      await game.forceFinish('test finished');
      assert.equal(s.lobbyHostActivity.get('room').sid, 'new-host');
      assert.equal(s.lobbyHostActivity.get('room').sinceMs, now, 'end starts full waiting period');
      now += LIMIT - 1;
      sweep();
      assert.equal(s.hasLobbyMember('new-host'), true);
      now++;
      sweep();
      assert.equal(s.hasLobbyMember('new-host'), false);
      assert.equal(s.hasLobbyMember('observer'), true, 'ordinary spectator not governed');
    } finally {
      clearTimeout(game.tickTimer);
      for (const pending of s.pendingRejoins.values()) clearTimeout(pending.timer);
    }
  }
  console.log('lobby host idle: all state/time regressions passed');
} finally {
  Date.now = realNow;
}
