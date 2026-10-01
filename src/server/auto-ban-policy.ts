export const RAPID_SURRENDER_TURNS = 20;
export const RAPID_SURRENDER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RAPID_SURRENDER_TRIGGER_COUNT = 3;
export const AFK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const AFK_TRIGGER_COUNT = 2;
export const AUTO_BAN_BASE_MS = 60 * 60 * 1000;
export const AUTO_BAN_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export type DisciplineCause = 'manual_surrender' | 'leave' | 'afk' | 'disconnect_timeout';
export type DisciplineType = 'rapid_surrender' | 'afk';

export interface DisciplineEventLike {
  cause: DisciplineCause;
  turn: number;
  elapsedMs: number;
  occurredAt: number;
}

export interface PolicyDecision {
  type: DisciplineType;
  triggerCount: number;
  bannedUntil: number;
}

export const pruneEvents = <T extends { occurredAt: number }>(
  events: T[],
  now: number,
  windowMs: number,
): T[] => events.filter((event) => now - event.occurredAt <= windowMs);

export const isRapidSurrender = (event: DisciplineEventLike): boolean =>
  event.cause === 'manual_surrender' && event.turn <= RAPID_SURRENDER_TURNS;

export const shouldCountForPolicy = (event: DisciplineEventLike): boolean =>
  isRapidSurrender(event) || event.cause === 'afk';

export const evaluateAutomaticDiscipline = (
  event: DisciplineEventLike,
  history: DisciplineEventLike[],
  now = event.occurredAt,
  automaticBanCount = 0,
): PolicyDecision | null => {
  if (event.cause === 'disconnect_timeout' || event.cause === 'leave') {
    return null;
  }

  if (isRapidSurrender(event)) {
    const recent = pruneEvents(history.filter(isRapidSurrender), now, RAPID_SURRENDER_WINDOW_MS);
    const triggerCount = recent.length + 1;
    if (triggerCount < RAPID_SURRENDER_TRIGGER_COUNT) {
      return null;
    }
    return {
      type: 'rapid_surrender',
      triggerCount,
      bannedUntil: now + automaticBanDuration(automaticBanCount),
    };
  }

  if (event.cause === 'afk') {
    const recent = pruneEvents(
      history.filter((item) => item.cause === 'afk'),
      now,
      AFK_WINDOW_MS,
    );
    const triggerCount = recent.length + 1;
    if (triggerCount < AFK_TRIGGER_COUNT) {
      return null;
    }
    return {
      type: 'afk',
      triggerCount,
      bannedUntil: now + automaticBanDuration(automaticBanCount),
    };
  }

  return null;
};

export const automaticBanDuration = (automaticBanCount: number): number =>
  Math.min(AUTO_BAN_MAX_MS, AUTO_BAN_BASE_MS * 2 ** Math.max(0, automaticBanCount));
