// 非官方 Bot 每日官方 Bot 房停留上限（BOT_DWELL_DAILY_LIMIT_MS = 3 小时）单元测试：
// 直接驱动 src/server/lobby-service.ts 的 LobbyService（运行时访问 private 成员，
// 伪造计时段起点与日期桶），不起服务。覆盖：
//   1) user bot 进有 serverBot 成员的房（官方 Bot 房）→ leaveLobby 累计停留；
//   2) 累计满 3h 后再进官方 Bot 房被拒（joinLobby 返回 blocked，房间成员数不变）；
//   3) 同 uid 进无 serverBot 的房不受限（也不计停留）；
//   4) 人类连接不受限（同 uid 桶已满也不拦）；
//   5) 日历日 rollover（伪造昨日桶）后重置可再进；
//   6) 对局中换绑（tryRejoin）计时段转移到新 sid 且保留 sinceMs，旧 sid 无记录则不新建。
// 运行：pnpm run test:bot-dwell-cap（tsx 直跑 src，无需构建）。

import assert from 'node:assert/strict';
import { LobbyService } from '../src/server/lobby-service.ts';

const BOT_DWELL_DAILY_LIMIT_MS = 3 * 3600_000;

function createHarness() {
  const io = {
    sockets: { sockets: new Map() },
    to() {
      return { emit() {} };
    },
    emit() {},
  };
  const service = new LobbyService({}, {});
  return { service, io };
}

// 让指定房间成为官方 Bot 房：放入一个托管 Bot 成员（serverBot: true）。
function makeServerBotRoom(service, room) {
  service.joinLobby(`sid-serverbot-${room}`, `official_bot_${room}`, room, { serverBot: true });
}

function memberCount(service, room) {
  return (service.lobbyPlayers.get(room) ?? []).length;
}

// 场景 1：user bot 进官方 Bot 房开始计时，leaveLobby 结算进当日桶。
{
  const { service } = createHarness();
  makeServerBotRoom(service, 'rooma');
  const res = service.joinLobby('sid-bot1', 'user_bot1', 'rooma', { bot: true });
  assert.equal(res.blocked, undefined, '未超限时应正常进房');
  assert.equal(service.botDwell.has('sid-bot1'), true, '进官方 Bot 房应开始计时段');
  // 伪造已停留 1 小时后离开。
  service.botDwell.get('sid-bot1').sinceMs = Date.now() - 3600_000;
  service.leaveLobby('sid-bot1', 'rooma');
  assert.equal(service.botDwell.has('sid-bot1'), false, '离开后计时段应清除');
  const bucket = service.botDwellDaily.get('user_bot1');
  assert.ok(bucket, '离开后应生成当日累计桶');
  assert.ok(
    bucket.ms >= 3600_000 && bucket.ms < 3600_000 + 5000,
    `当日桶应累计约 1 小时（实际 ${bucket?.ms}ms）`,
  );
  console.log('场景 1 通过：user bot 进官方 Bot 房，leaveLobby 累计停留');
}

// 场景 2：累计满 3 小时后再进官方 Bot 房被拒，房间成员数不变。
{
  const { service } = createHarness();
  makeServerBotRoom(service, 'roomb');
  const before = memberCount(service, 'roomb');
  service.botDwellDaily.set('user_bot2', { date: service.localDateKey(), ms: BOT_DWELL_DAILY_LIMIT_MS });
  const res = service.joinLobby('sid-bot2', 'user_bot2', 'roomb', { bot: true });
  assert.equal(typeof res.blocked, 'string', '累计满 3h 后 joinLobby 应返回 blocked');
  assert.ok(res.blocked.includes('3 小时'), 'blocked 文案应说明 3 小时上限');
  assert.equal(memberCount(service, 'roomb'), before, '被拒后房间成员数不变');
  assert.equal(service.lobbyOfSid.has('sid-bot2'), false, '被拒后不应登记房间归属');
  assert.equal(service.botDwell.has('sid-bot2'), false, '被拒后不应开始计时段');
  // 另一个官方 Bot 房同样被拒（上限按 uid 不按房间）。
  makeServerBotRoom(service, 'roomb2');
  const res2 = service.joinLobby('sid-bot2b', 'user_bot2', 'roomb2', { bot: true });
  assert.equal(typeof res2.blocked, 'string', '当日不得再进入任何官方 Bot 房');
  console.log('场景 2 通过：累计满 3h 后进入官方 Bot 房被拒');
}

// 场景 3：同 uid 进无 serverBot 的普通房不受限，也不计停留。
{
  const { service } = createHarness();
  service.botDwellDaily.set('user_bot3', { date: service.localDateKey(), ms: BOT_DWELL_DAILY_LIMIT_MS });
  const res = service.joinLobby('sid-bot3', 'user_bot3', 'roomc', { bot: true });
  assert.equal(res.blocked, undefined, '无 serverBot 的房不受停留上限限制');
  assert.equal(service.botDwell.has('sid-bot3'), false, '非官方 Bot 房不计停留');
  console.log('场景 3 通过：同 uid 进普通房不受限且不计停留');
}

// 场景 4：人类连接不受限（即使同名 uid 的桶已满）；托管 Bot 也不受限。
{
  const { service } = createHarness();
  makeServerBotRoom(service, 'roomd');
  service.botDwellDaily.set('user_human', { date: service.localDateKey(), ms: BOT_DWELL_DAILY_LIMIT_MS });
  const resHuman = service.joinLobby('sid-human', 'user_human', 'roomd');
  assert.equal(resHuman.blocked, undefined, '人类连接不受停留上限限制');
  assert.equal(service.botDwell.has('sid-human'), false, '人类连接不计停留');
  const resServerBot = service.joinLobby('sid-serverbot2', 'user_bot_x', 'roomd', {
    bot: true,
    serverBot: true,
  });
  assert.equal(resServerBot.blocked, undefined, '官方托管 Bot 不受停留上限限制');
  console.log('场景 4 通过：人类与托管 Bot 不受限');
}

// 场景 5：日历日 rollover——伪造昨日已满的桶，今日应重置并可再进。
{
  const { service } = createHarness();
  makeServerBotRoom(service, 'roome');
  service.botDwellDaily.set('user_bot5', { date: '2000-01-01', ms: BOT_DWELL_DAILY_LIMIT_MS });
  const res = service.joinLobby('sid-bot5', 'user_bot5', 'roome', { bot: true });
  assert.equal(res.blocked, undefined, '跨日后当日桶重置，可再进官方 Bot 房');
  //  rollover 后再结算：旧桶应被重置为今日日期。
  service.leaveLobby('sid-bot5', 'roome');
  const bucket = service.botDwellDaily.get('user_bot5');
  assert.equal(bucket?.date, service.localDateKey(), '累加时旧日期桶应惰性重置为今日');
  assert.ok(bucket.ms < 5000, `重置后只累计本次停留（实际 ${bucket?.ms}ms）`);
  console.log('场景 5 通过：日历日 rollover 后重置可再进');
}

// 场景 6：对局中换绑（tryRejoin）——计时段转移到新 sid 且保留 sinceMs；旧 sid 无记录不新建。
{
  const { service, io } = createHarness();
  makeServerBotRoom(service, 'roomf');
  service.joinLobby('sid-bot6', 'user_bot6', 'roomf', { bot: true });
  const sinceMs = Date.now() - 1800_000;
  service.botDwell.get('sid-bot6').sinceMs = sinceMs;
  // 布置对局进行中 + 断线宽限期登记（bot 身份），使 tryRejoin 走 pending 路径。
  const fakeGame = {
    findPlayerSidByName(username) {
      return username === 'user_bot6' ? 'sid-bot6' : null;
    },
    rebindPlayer() {
      return true;
    },
  };
  service.gameInstances.set(service.getLobbyVal('roomf'), fakeGame);
  const timer = setTimeout(() => {}, 60_000);
  service.pendingRejoins.set(`${service.getLobbyVal('roomf')}:user_bot6`, {
    oldSid: 'sid-bot6',
    lobbyId: 'roomf',
    isBot: true,
    timer,
  });
  const ok = service.tryRejoin(io, 'sid-bot6-new', 'user_bot6', 'roomf', true);
  clearTimeout(timer);
  assert.equal(ok, true, 'tryRejoin 换绑应成功');
  assert.equal(service.botDwell.has('sid-bot6'), false, '旧 sid 计时段应移除');
  const record = service.botDwell.get('sid-bot6-new');
  assert.ok(record, '计时段应转移到新 sid');
  assert.equal(record.sinceMs, sinceMs, '换绑后 sinceMs 保留（断线重连不丢计时段）');

  // 对照：旧 sid 无计时段时不新建（普通房成员重连）。
  service.joinLobby('sid-human6', 'user_h6', 'roomf');
  const fakeGame2 = {
    findPlayerSidByName(username) {
      return username === 'user_h6' ? 'sid-human6' : null;
    },
    rebindPlayer() {
      return true;
    },
  };
  service.gameInstances.set(service.getLobbyVal('roomf'), fakeGame2);
  const timer2 = setTimeout(() => {}, 60_000);
  service.pendingRejoins.set(`${service.getLobbyVal('roomf')}:user_h6`, {
    oldSid: 'sid-human6',
    lobbyId: 'roomf',
    isBot: false,
    timer: timer2,
  });
  const ok2 = service.tryRejoin(io, 'sid-human6-new', 'user_h6', 'roomf', false);
  clearTimeout(timer2);
  assert.equal(ok2, true, '人类换绑应成功');
  assert.equal(service.botDwell.has('sid-human6-new'), false, '旧 sid 无记录时不新建计时段');
  console.log('场景 6 通过：断线重连计时段转移且 sinceMs 保留，无记录不新建');
}

console.log('全部官方 Bot 房停留上限场景通过');
