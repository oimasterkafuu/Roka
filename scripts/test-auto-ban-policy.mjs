import assert from 'node:assert/strict';
import {
  AFK_TRIGGER_COUNT,
  AFK_WINDOW_MS,
  AUTO_BAN_BASE_MS,
  AUTO_BAN_MAX_MS,
  AUTOBAN_COUNT_RESET_IDLE_MS,
  RAPID_SURRENDER_TRIGGER_COUNT,
  RAPID_SURRENDER_TURNS,
  RAPID_SURRENDER_WINDOW_MS,
  automaticBanDuration,
  evaluateAutomaticDiscipline,
  shouldResetAutomaticBanCount,
} from '../src/server/auto-ban-policy.ts';

const now = 100_000_000_000;
const rapid = (occurredAt, turn = 10) => ({
  cause: 'manual_surrender',
  turn,
  elapsedMs: occurredAt,
  occurredAt,
});
const afk = (occurredAt, playerCount = 4) => ({
  cause: 'afk',
  turn: 100,
  elapsedMs: occurredAt,
  occurredAt,
  playerCount,
});

// 常数：快速投降 24h 内 3 次触发，AFK 24h 内 6 次触发，14 天无违规重置梯度。
assert.equal(RAPID_SURRENDER_TRIGGER_COUNT, 3);
assert.equal(RAPID_SURRENDER_WINDOW_MS, 24 * 60 * 60 * 1000);
assert.equal(AFK_TRIGGER_COUNT, 6);
assert.equal(AFK_WINDOW_MS, 24 * 60 * 60 * 1000);
assert.equal(AUTOBAN_COUNT_RESET_IDLE_MS, 14 * 24 * 60 * 60 * 1000);

// 快速投降：窗口内第 3 次触发封禁（计数 0 → 1 小时档）。
assert.equal(evaluateAutomaticDiscipline(rapid(now, RAPID_SURRENDER_TURNS), [], now), null);
assert.equal(evaluateAutomaticDiscipline(rapid(now, RAPID_SURRENDER_TURNS + 1), [], now), null);
assert.equal(
  evaluateAutomaticDiscipline(
    rapid(now, RAPID_SURRENDER_TURNS),
    Array.from({ length: RAPID_SURRENDER_TRIGGER_COUNT - 1 }, (_, i) => rapid(now - 1 - i)),
    now,
  )?.bannedUntil,
  now + AUTO_BAN_BASE_MS,
);
assert.equal(
  evaluateAutomaticDiscipline(
    rapid(now, RAPID_SURRENDER_TURNS),
    Array.from({ length: RAPID_SURRENDER_TRIGGER_COUNT - 2 }, (_, i) => rapid(now - 1 - i)),
    now,
  ),
  null,
);
// 窗口外的快速投降历史不计入。
assert.equal(
  evaluateAutomaticDiscipline(
    rapid(now, RAPID_SURRENDER_TURNS),
    [rapid(now - 1), rapid(now - RAPID_SURRENDER_WINDOW_MS - 1)],
    now,
  ),
  null,
);

// AFK：窗口内第 6 次触发封禁。
assert.equal(
  evaluateAutomaticDiscipline(
    afk(now),
    Array.from({ length: AFK_TRIGGER_COUNT - 1 }, (_, i) => afk(now - 1 - i)),
    now,
  )?.type,
  'afk',
);
assert.equal(
  evaluateAutomaticDiscipline(
    afk(now),
    Array.from({ length: AFK_TRIGGER_COUNT - 2 }, (_, i) => afk(now - 1 - i)),
    now,
  ),
  null,
);
assert.equal(evaluateAutomaticDiscipline(afk(now), [afk(now - AFK_WINDOW_MS - 1)], now), null);

// 1v1（playerCount=2）对局的 AFK 不触发封禁，历史中的 1v1 AFK 也不计入计数。
assert.equal(evaluateAutomaticDiscipline(afk(now, 2), Array.from({ length: 10 }, (_, i) => afk(now - 1 - i)), now), null);
assert.equal(
  evaluateAutomaticDiscipline(
    afk(now, 3),
    Array.from({ length: AFK_TRIGGER_COUNT - 1 }, (_, i) => afk(now - 1 - i, 2)),
    now,
  ),
  null,
);
// 3 人局 AFK 正常计数：5 条 3 人局历史 + 当前 3 人局 → 触发。
assert.equal(
  evaluateAutomaticDiscipline(
    afk(now, 3),
    Array.from({ length: AFK_TRIGGER_COUNT - 1 }, (_, i) => afk(now - 1 - i, 3)),
    now,
  )?.bannedUntil,
  now + AUTO_BAN_BASE_MS,
);
// 1v1 不影响快速投降计数（playerCount 仅作用于 afk）。
assert.equal(
  evaluateAutomaticDiscipline(
    { ...rapid(now, RAPID_SURRENDER_TURNS), playerCount: 2 },
    Array.from({ length: RAPID_SURRENDER_TRIGGER_COUNT - 1 }, (_, i) => rapid(now - 1 - i)),
    now,
  )?.type,
  'rapid_surrender',
);

// 封禁时长梯度：计数指数增长、7 天上限。
assert.equal(automaticBanDuration(0), AUTO_BAN_BASE_MS);
assert.equal(automaticBanDuration(2), AUTO_BAN_BASE_MS * 4);
assert.equal(automaticBanDuration(20), AUTO_BAN_MAX_MS);
assert.equal(
  evaluateAutomaticDiscipline(
    rapid(now, RAPID_SURRENDER_TURNS),
    Array.from({ length: 20 }, (_, i) => rapid(now - i)),
    now,
    20,
  )?.bannedUntil,
  now + AUTO_BAN_MAX_MS,
);

// leave / disconnect_timeout 不触发。
assert.equal(
  evaluateAutomaticDiscipline(
    { cause: 'disconnect_timeout', turn: 1, elapsedMs: 1, occurredAt: now },
    [rapid(now - 1), rapid(now - 2)],
    now,
  ),
  null,
);
assert.equal(
  evaluateAutomaticDiscipline({ cause: 'leave', turn: 1, elapsedMs: 1, occurredAt: now }, [], now),
  null,
);

// 14 天无违规重置：满 14 天重置（封禁回到 1 小时档），不满 14 天继续累加。
assert.equal(shouldResetAutomaticBanCount([], now), true);
assert.equal(shouldResetAutomaticBanCount([afk(now - AUTOBAN_COUNT_RESET_IDLE_MS)], now), true);
assert.equal(shouldResetAutomaticBanCount([rapid(now - AUTOBAN_COUNT_RESET_IDLE_MS - 1)], now), true);
assert.equal(shouldResetAutomaticBanCount([afk(now - AUTOBAN_COUNT_RESET_IDLE_MS + 1)], now), false);
assert.equal(shouldResetAutomaticBanCount([afk(now - 1)], now), false);
// 非违规事件（leave）不刷新违规时间。
assert.equal(
  shouldResetAutomaticBanCount(
    [
      afk(now - AUTOBAN_COUNT_RESET_IDLE_MS),
      { cause: 'leave', turn: 5, elapsedMs: 5, occurredAt: now - 1 },
    ],
    now,
  ),
  true,
);
// 重置后（计数归零）从 1 小时档重新算起；未重置时按既有计数累加。
const triggerHistory = Array.from({ length: RAPID_SURRENDER_TRIGGER_COUNT - 1 }, (_, i) =>
  rapid(now - 1 - i),
);
assert.equal(shouldResetAutomaticBanCount(triggerHistory, now), false);
assert.equal(
  evaluateAutomaticDiscipline(rapid(now, RAPID_SURRENDER_TURNS), triggerHistory, now, 0)
    ?.bannedUntil,
  now + AUTO_BAN_BASE_MS,
);
assert.equal(
  evaluateAutomaticDiscipline(rapid(now, RAPID_SURRENDER_TURNS), triggerHistory, now, 3)
    ?.bannedUntil,
  now + AUTO_BAN_BASE_MS * 8,
);

console.log('auto-ban policy tests passed');
