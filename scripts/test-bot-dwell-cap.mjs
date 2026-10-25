// 非官方 AI 每日官方 Bot 房停留上限（4 小时）单元测试。
// AI 身份与房间标记一致：未通过 humanVerified 且非 serverBot，不看 JWT 或 token 标记。
// 直接驱动 LobbyService，伪造计时段起点与日期桶，不起服务。覆盖：
//   1) 未验证普通连接进官方 Bot 房计时，leaveLobby 累计停留；
//   2) 累计满 4h 后再进任何官方 Bot 房均被拒；
//   3) 普通房不受限；真人及官方托管 Bot 不受限；
//   4) 日历日 rollover 后重置；
//   5) 对局换绑保留计时段；补验真人后停止计时；
//   6) 准备阶段到限自动踢出，对局中不打断，终局后立即检查；
//   7) 进房检查合并历史桶与当前未结算时段。
// 运行：pnpm run test:bot-dwell-cap（tsx 直跑 src，无需构建）。

import assert from 'node:assert/strict';
import { LobbyService } from '../src/server/lobby-service.ts';

const BOT_DWELL_DAILY_LIMIT_MS = 4 * 3600_000;

function createHarness() {
  const kicks = [];
  const io = {
    sockets: { sockets: new Map() },
    to(target) {
      return {
        emit(event) {
          if (event === 'room_kick') kicks.push(target);
        },
      };
    },
    emit() {},
  };
  const service = new LobbyService({}, {});
  return { service, io, kicks };
}

function makeServerBotRoom(service, room) {
  service.joinLobby(`sid-serverbot-${room}`, `official_bot_${room}`, room, { serverBot: true });
}

function memberCount(service, room) {
  return (service.lobbyPlayers.get(room) ?? []).length;
}

function joinAi(service, sid, uid, room) {
  return service.joinLobby(sid, uid, room);
}

// 场景 1：不带 bot/token 标记的未验证连接也按房间 AI 口径计时。
{
  const { service } = createHarness();
  makeServerBotRoom(service, 'rooma');
  const res = joinAi(service, 'sid-ai1', 'user_ai1', 'rooma');
  assert.equal(res.blocked, undefined, '未超限时应正常进房');
  assert.equal(service.botDwell.has('sid-ai1'), true, '未验证普通连接应开始计时');
  service.botDwell.get('sid-ai1').sinceMs = Date.now() - 3600_000;
  service.leaveLobby('sid-ai1', 'rooma');
  assert.equal(service.botDwell.has('sid-ai1'), false, '离开后计时段应清除');
  const bucket = service.botDwellDaily.get('user_ai1');
  assert.ok(bucket, '离开后应生成当日累计桶');
  assert.ok(
    bucket.ms >= 3600_000 && bucket.ms < 3600_000 + 5000,
    `当日桶应累计约 1 小时（实际 ${bucket?.ms}ms）`,
  );
  console.log('场景 1 通过：AI 身份不依赖 JWT 或 token 标记');
}

// 场景 2：累计满 4 小时后再进官方 Bot 房被拒，房间成员数不变。
{
  const { service } = createHarness();
  makeServerBotRoom(service, 'roomb');
  const before = memberCount(service, 'roomb');
  service.botDwellDaily.set('user_ai2', { date: service.localDateKey(), ms: BOT_DWELL_DAILY_LIMIT_MS });
  const res = joinAi(service, 'sid-ai2', 'user_ai2', 'roomb');
  assert.equal(typeof res.blocked, 'string', '累计满 4h 后 joinLobby 应返回 blocked');
  assert.ok(res.blocked.includes('4 小时'), 'blocked 文案应说明 4 小时上限');
  assert.equal(memberCount(service, 'roomb'), before, '被拒后房间成员数不变');
  assert.equal(service.lobbyOfSid.has('sid-ai2'), false, '被拒后不应登记房间归属');
  assert.equal(service.botDwell.has('sid-ai2'), false, '被拒后不应开始计时段');
  makeServerBotRoom(service, 'roomb2');
  const res2 = joinAi(service, 'sid-ai2b', 'user_ai2', 'roomb2');
  assert.equal(typeof res2.blocked, 'string', '当日不得再进入任何官方 Bot 房');
  console.log('场景 2 通过：累计满 4h 后进入官方 Bot 房被拒');
}

// 场景 3：普通房不受限；已验证真人与官方托管 Bot 不受限。
{
  const { service } = createHarness();
  service.botDwellDaily.set('user_ai3', { date: service.localDateKey(), ms: BOT_DWELL_DAILY_LIMIT_MS });
  const resNormal = joinAi(service, 'sid-ai3', 'user_ai3', 'roomc');
  assert.equal(resNormal.blocked, undefined, '无 serverBot 的房不受停留上限限制');
  assert.equal(service.botDwell.has('sid-ai3'), false, '非官方 Bot 房不计停留');

  makeServerBotRoom(service, 'roomd');
  service.botDwellDaily.set('user_human', { date: service.localDateKey(), ms: BOT_DWELL_DAILY_LIMIT_MS });
  service.humanVerified.add('sid-human');
  const resHuman = service.joinLobby('sid-human', 'user_human', 'roomd', { bot: true });
  assert.equal(resHuman.blocked, undefined, '真人即使带 bot 标记也不受限');
  assert.equal(service.botDwell.has('sid-human'), false, '真人不计停留');
  service.botDwellDaily.set('user_ai_x', { date: service.localDateKey(), ms: BOT_DWELL_DAILY_LIMIT_MS });
  const resServerBot = service.joinLobby('sid-serverbot2', 'user_ai_x', 'roomd', {
    serverBot: true,
  });
  assert.equal(resServerBot.blocked, undefined, '官方托管 Bot 不受停留上限限制');
  assert.equal(service.botDwell.has('sid-serverbot2'), false, '官方托管 Bot 不计停留');
  console.log('场景 3 通过：普通房、真人与官方托管 Bot 不受限');
}

// 场景 4：日历日 rollover——昨日已满的桶今日重置并可再进。
{
  const { service } = createHarness();
  makeServerBotRoom(service, 'roome');
  service.botDwellDaily.set('user_ai5', { date: '2000-01-01', ms: BOT_DWELL_DAILY_LIMIT_MS });
  const res = joinAi(service, 'sid-ai5', 'user_ai5', 'roome');
  assert.equal(res.blocked, undefined, '跨日后当日桶重置，可再进官方 Bot 房');
  service.leaveLobby('sid-ai5', 'roome');
  const bucket = service.botDwellDaily.get('user_ai5');
  assert.equal(bucket?.date, service.localDateKey(), '累加时旧日期桶应惰性重置为今日日期');
  assert.ok(bucket.ms < 5000, `重置后只累计本次停留（实际 ${bucket?.ms}ms）`);
  console.log('场景 4 通过：日历日 rollover 后重置可再进');
}

// 场景 5：对局中换绑，计时段转移到新 sid 且保留 sinceMs。
{
  const { service, io } = createHarness();
  makeServerBotRoom(service, 'roomf');
  joinAi(service, 'sid-ai6', 'user_ai6', 'roomf');
  const sinceMs = Date.now() - 1800_000;
  service.botDwell.get('sid-ai6').sinceMs = sinceMs;
  const fakeGame = {
    findPlayerSidByName(username) {
      return username === 'user_ai6' ? 'sid-ai6' : null;
    },
    rebindPlayer() {
      return true;
    },
  };
  service.gameInstances.set(service.getLobbyVal('roomf'), fakeGame);
  const timer = setTimeout(() => {}, 60_000);
  service.pendingRejoins.set(`${service.getLobbyVal('roomf')}:user_ai6`, {
    oldSid: 'sid-ai6',
    lobbyId: 'roomf',
    isBot: false,
    timer,
  });
  const ok = service.tryRejoin(io, 'sid-ai6-new', 'user_ai6', 'roomf', false);
  clearTimeout(timer);
  assert.equal(ok, true, 'tryRejoin 换绑应成功');
  assert.equal(service.botDwell.has('sid-ai6'), false, '旧 sid 计时段应移除');
  const record = service.botDwell.get('sid-ai6-new');
  assert.ok(record, '计时段应转移到新 sid');
  assert.equal(record.sinceMs, sinceMs, '换绑后 sinceMs 保留');
  console.log('场景 5 通过：断线重连计时段转移且 sinceMs 保留');
}

// 场景 6：准备阶段累计达到 4 小时自动踢出，离开后结算且当日禁止重进。
{
  const { service, io, kicks } = createHarness();
  makeServerBotRoom(service, 'roomg');
  joinAi(service, 'sid-ai7', 'user_ai7', 'roomg');
  service.heartbeatExempt.add('sid-ai7');
  service.botDwell.get('sid-ai7').sinceMs = Date.now() - BOT_DWELL_DAILY_LIMIT_MS;
  service.sweepInactiveLobbyMembers(io);
  assert.deepEqual(kicks, ['sid_sid-ai7'], '准备阶段到限应收到 room_kick');
  assert.equal(service.lobbyOfSid.has('sid-ai7'), false, '准备阶段到限应自动移出');
  assert.equal(service.botDwell.has('sid-ai7'), false, '自动踢出后应结算并清除计时段');
  assert.ok(service.botDwellDailyMs('user_ai7') >= BOT_DWELL_DAILY_LIMIT_MS, '踢出应累计当日停留');
  const res = joinAi(service, 'sid-ai7-new', 'user_ai7', 'roomg');
  assert.equal(typeof res.blocked, 'string', '自动踢出后当日不得重进');
  console.log('场景 6 通过：准备阶段到限自动踢出并禁止重进');
}

// 场景 7：对局中超过 4 小时不打断；终局删除 gameInstances 后立即检查并踢出。
{
  const { service, io, kicks } = createHarness();
  makeServerBotRoom(service, 'roomh');
  joinAi(service, 'sid-ai8', 'user_ai8', 'roomh');
  service.botDwell.get('sid-ai8').sinceMs = Date.now() - BOT_DWELL_DAILY_LIMIT_MS;
  const roomVal = service.getLobbyVal('roomh');
  service.gameInstances.set(roomVal, {});
  service.sweepInactiveLobbyMembers(io);
  assert.deepEqual(kicks, [], '对局进行中不应自动踢出');
  assert.equal(service.lobbyOfSid.has('sid-ai8'), true, '对局进行中应保留席位');
  service.gameInstances.delete(roomVal);
  service.sweepBotDwellLimits(io, 'roomh');
  assert.deepEqual(kicks, ['sid_sid-ai8'], '终局检查应立即发送 room_kick');
  assert.equal(service.lobbyOfSid.has('sid-ai8'), false, '终局检查后应移出超限 AI');
  console.log('场景 7 通过：对局中不打断，终局后立即检查');
}

// 场景 8：补验真人后停止计时，即使此前作为 AI 的计时段已到限也不踢。
{
  const { service, io, kicks } = createHarness();
  makeServerBotRoom(service, 'roomi');
  joinAi(service, 'sid-ai9', 'user_ai9', 'roomi');
  service.botDwell.get('sid-ai9').sinceMs = Date.now() - BOT_DWELL_DAILY_LIMIT_MS;
  service.humanVerified.add('sid-ai9');
  service.reorderLobbyForVerification('roomi', 'sid-ai9');
  assert.equal(service.botDwell.has('sid-ai9'), false, '补验真人后应停止计时');
  service.sweepInactiveLobbyMembers(io);
  assert.deepEqual(kicks, [], '补验真人后不应按 AI 上限踢出');
  assert.equal(service.lobbyOfSid.has('sid-ai9'), true, '补验真人后应保留房间席位');
  console.log('场景 8 通过：补验真人后解除 AI 停留限制');
}

// 场景 9：进房拦截合并当日历史桶与同 uid 的进行中计时段。
{
  const { service } = createHarness();
  makeServerBotRoom(service, 'roomj');
  makeServerBotRoom(service, 'roomj2');
  service.botDwellDaily.set('user_ai10', { date: service.localDateKey(), ms: 3 * 3600_000 });
  joinAi(service, 'sid-ai10', 'user_ai10', 'roomj');
  service.botDwell.get('sid-ai10').sinceMs = Date.now() - 3600_000;
  const res = joinAi(service, 'sid-ai10b', 'user_ai10', 'roomj2');
  assert.equal(typeof res.blocked, 'string', '历史 3h + 当前 1h 应视为达到 4h 上限');
  console.log('场景 9 通过：进房拦截包含当前未结算停留时间');
}

console.log('全部官方 Bot 房非官方 AI 停留上限场景通过');
