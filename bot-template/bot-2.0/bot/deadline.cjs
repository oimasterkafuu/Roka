'use strict';

// A per-decision wall-clock budget.  At 4x a tick is 125 ms, so a planner pass
// must leave the event loop with enough room to emit its action before the
// next update frame.  `marginMs` is the reserve kept for that hand-off.
//
// `check()` is intentionally cheap: the clock is probed once at the start and
// then only every `checkInterval` calls.  `expired()` and `remaining()` are
// exact and always probe the clock.

const DEFAULT_BUDGET_MS = 80;
const DEFAULT_MARGIN_MS = 8;
const DEFAULT_CHECK_INTERVAL = 2;

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function createDeadline(options = {}) {
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const budgetMs = Math.max(0, finite(options.budgetMs, DEFAULT_BUDGET_MS));
  const marginMs = Math.max(0, finite(options.marginMs, DEFAULT_MARGIN_MS));
  const checkInterval = Math.max(1, Math.floor(finite(options.checkInterval, DEFAULT_CHECK_INTERVAL)));
  const startedAt = clock();
  // A zero budget must expire immediately, even when the fake clock is frozen.
  const deadlineAt = startedAt + Math.max(0, budgetMs - marginMs);
  const counters = { checks: 0, probes: 0 };
  let isExpired = deadlineAt <= startedAt;

  function probe() {
    counters.probes += 1;
    if (!isExpired && clock() >= deadlineAt) isExpired = true;
    return isExpired;
  }

  function expired() {
    return probe();
  }

  function check() {
    counters.checks += 1;
    if (isExpired) return true;
    // Probe on the first check and then only at bounded intervals.
    if (counters.checks !== 1 && counters.checks % checkInterval !== 0) return false;
    return probe();
  }

  function remaining() {
    counters.probes += 1;
    const left = Math.max(0, deadlineAt - clock());
    if (left <= 0) isExpired = true;
    return left;
  }

  return {
    budgetMs,
    marginMs,
    checkInterval,
    startedAt,
    deadlineAt,
    expired,
    check,
    remaining,
    counters: () => ({ ...counters, expired: isExpired }),
    stats: () => ({
      budgetMs,
      marginMs,
      checkInterval,
      startedAt,
      deadlineAt,
      remainingMs: Math.max(0, deadlineAt - clock()),
      checks: counters.checks,
      probes: counters.probes,
      expired: isExpired,
    }),
  };
}

module.exports = { createDeadline, DEFAULT_BUDGET_MS, DEFAULT_MARGIN_MS, DEFAULT_CHECK_INTERVAL };
