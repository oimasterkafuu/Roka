import assert from 'node:assert/strict';
import {
  AFK_TRIGGER_COUNT,
  AFK_WINDOW_MS,
  AUTO_BAN_BASE_MS,
  AUTO_BAN_MAX_MS,
  RAPID_SURRENDER_TRIGGER_COUNT,
  RAPID_SURRENDER_TURNS,
  evaluateAutomaticDiscipline,
} from '../src/server/auto-ban-policy.ts';

const now = 1_000_000;
const rapid = (occurredAt, turn = 10) => ({
  cause: 'manual_surrender',
  turn,
  elapsedMs: occurredAt,
  occurredAt,
});
const afk = (occurredAt) => ({ cause: 'afk', turn: 100, elapsedMs: occurredAt, occurredAt });

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
assert.equal(
  evaluateAutomaticDiscipline(afk(now), [afk(now - 1)], now)?.type,
  'afk',
);
assert.equal(evaluateAutomaticDiscipline(afk(now), [afk(now - AFK_WINDOW_MS - 1)], now), null);
assert.equal(
  evaluateAutomaticDiscipline(
    rapid(now, RAPID_SURRENDER_TURNS),
    Array.from({ length: 20 }, (_, i) => rapid(now - i)),
    now,
    20,
  )?.bannedUntil,
  now + AUTO_BAN_MAX_MS,
);
assert.equal(
  evaluateAutomaticDiscipline({ cause: 'disconnect_timeout', turn: 1, elapsedMs: 1, occurredAt: now }, [rapid(now - 1), rapid(now - 2)], now),
  null,
);
assert.equal(RAPID_SURRENDER_TRIGGER_COUNT, 10);
assert.equal(AFK_WINDOW_MS, 24 * 60 * 60 * 1000);
assert.equal(AFK_TRIGGER_COUNT, 2);
console.log('auto-ban policy tests passed');
