// 房间停留上限（LOBBY_MAX_DWELL_MS = 12 小时）单元测试：
// 直接驱动 src/server/lobby-service.ts 的 LobbyService（运行时访问 private 成员），
// 用假 io 捕获 room_kick。覆盖：停留超限被踢（复用心跳超时同一踢出路径）、
// 停留未超限保留、对局进行中豁免、heartbeatExempt bot 豁免、
// 原心跳超时踢出逻辑不变、离开/被踢后停留记录清理且重进房间重置计时。
// 运行：pnpm run test:lobby-dwell（tsx 直跑 src，无需构建）。

import assert from 'node:assert/strict';
import { LobbyService } from '../src/server/lobby-service.ts';

const LOBBY_MAX_DWELL_MS = 12 * 3600_000;
const LOBBY_HEARTBEAT_TIMEOUT_MS = 600_000;

function createHarness() {
  const kicks = [];
  const io = {
    sockets: { sockets: new Map() },
    to(target) {
      return {
        emit(event) {
          if (event === 'room_kick') {
            kicks.push(target);
          }
        },
      };
    },
    emit() {},
  };
  const service = new LobbyService({}, {});
  return { service, io, kicks };
}

function sweep(service, io) {
  service.sweepInactiveLobbyMembers(io);
}

function inLobby(service, sid) {
  return service.lobbyOfSid.has(sid);
}

// 场景 1：停留超过 12 小时、心跳仍然新鲜（挂着的标签页）——应被移出并收到 room_kick。
{
  const { service, io, kicks } = createHarness();
  service.joinLobby('sid-over', 'user_over', 'roomover');
  service.lobbyJoinedAt.set('sid-over', Date.now() - LOBBY_MAX_DWELL_MS - 1);
  sweep(service, io);
  assert.deepEqual(kicks, ['sid_sid-over'], '停留超限应收到 room_kick');
  assert.equal(inLobby(service, 'sid-over'), false, '停留超限应被移出房间');
  assert.equal(service.lobbyJoinedAt.has('sid-over'), false, '被踢后停留记录应清理');
  assert.equal((service.lobbyPlayers.get('roomover') ?? []).length, 0, '成员列表应移除');
  console.log('场景 1 通过：停留超限（心跳新鲜）被移出房间');
}

// 场景 2：停留未达上限且心跳新鲜——保留在房内。
{
  const { service, io, kicks } = createHarness();
  service.joinLobby('sid-under', 'user_under', 'roomunder');
  service.lobbyJoinedAt.set('sid-under', Date.now() - (LOBBY_MAX_DWELL_MS - 60_000));
  sweep(service, io);
  assert.deepEqual(kicks, [], '停留未超限不应被踢');
  assert.equal(inLobby(service, 'sid-under'), true, '停留未超限应保留在房内');
  console.log('场景 2 通过：停留未达上限保留');
}

// 场景 3：对局进行中——即使停留超限也不踢，等本局结束回到准备阶段再处理。
{
  const { service, io, kicks } = createHarness();
  service.joinLobby('sid-game', 'user_game', 'roomgame');
  service.lobbyJoinedAt.set('sid-game', Date.now() - LOBBY_MAX_DWELL_MS - 1);
  service.gameInstances.set(service.getLobbyVal('roomgame'), {});
  sweep(service, io);
  assert.deepEqual(kicks, [], '对局进行中不应踢出');
  assert.equal(inLobby(service, 'sid-game'), true, '对局进行中应保留席位');
  console.log('场景 3 通过：对局进行中豁免停留上限');
}

// 场景 4：heartbeatExempt 中的 bot 连接——不受停留上限影响。
{
  const { service, io, kicks } = createHarness();
  service.joinLobby('sid-bot', 'user_bot', 'roombot', { bot: true });
  service.heartbeatExempt.add('sid-bot');
  service.lobbyJoinedAt.set('sid-bot', Date.now() - LOBBY_MAX_DWELL_MS - 1);
  sweep(service, io);
  assert.deepEqual(kicks, [], '豁免 bot 不应被踢');
  assert.equal(inLobby(service, 'sid-bot'), true, '豁免 bot 应保留在房内');
  console.log('场景 4 通过：heartbeatExempt bot 豁免停留上限');
}

// 场景 5：原心跳超时踢出逻辑不变——停留未超限但 600 秒无心跳仍被踢。
{
  const { service, io, kicks } = createHarness();
  service.joinLobby('sid-silent', 'user_silent', 'roomsilent');
  service.lobbyHeartbeats.set('sid-silent', Date.now() - LOBBY_HEARTBEAT_TIMEOUT_MS - 1);
  sweep(service, io);
  assert.deepEqual(kicks, ['sid_sid-silent'], '心跳超时应收到 room_kick');
  assert.equal(inLobby(service, 'sid-silent'), false, '心跳超时应被移出房间');
  console.log('场景 5 通过：原心跳超时踢出逻辑不变');
}

// 场景 6：离开房间清理停留记录，重进房间停留计时重置。
{
  const { service, io } = createHarness();
  service.joinLobby('sid-re', 'user_re', 'roomre');
  service.lobbyJoinedAt.set('sid-re', Date.now() - LOBBY_MAX_DWELL_MS - 1);
  service.checkLeave(io, 'sid-re', () => {}, 'user_re');
  assert.equal(service.lobbyJoinedAt.has('sid-re'), false, '离开房间后停留记录应清理');
  service.joinLobby('sid-re', 'user_re', 'roomre');
  const dwell = Date.now() - service.lobbyJoinedAt.get('sid-re');
  assert.ok(dwell < 5000, `重进房间停留计时应重置（实际 dwell=${dwell}ms）`);
  sweep(service, io);
  assert.equal(inLobby(service, 'sid-re'), true, '重置后不应被停留上限踢出');
  console.log('场景 6 通过：离开清理记录、重进重置停留计时');
}

console.log('全部停留上限场景通过');
