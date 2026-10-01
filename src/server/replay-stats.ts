import { ReplayListItem } from '../types';

export const REPLAY_STATS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REPLAY_STATS_BUCKET_COUNT = 24;
const HOUR_MS = 60 * 60 * 1000;
const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

const SHANGHAI_HOUR_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SHANGHAI_TIME_ZONE,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
});

export interface ReplayStatsBucket {
  start: number;
  label: string;
  count: number;
}

export interface ReplayStats {
  games: number;
  buckets: ReplayStatsBucket[];
}

function formatBucketLabel(timestamp: number): string {
  const parts = SHANGHAI_HOUR_FORMATTER.formatToParts(new Date(timestamp));
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
  return `${month}-${day} ${hour}:00`;
}

/**
 * 汇总当前时刻向前 24 小时内已结束的回放。
 * 时间窗口按 Unix 秒读取；图表按 Asia/Shanghai 的自然小时生成最近 24 个 bucket。
 */
export function buildReplayStats(items: ReplayListItem[], now: Date | number = Date.now()): ReplayStats {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const cutoffMs = nowMs - REPLAY_STATS_WINDOW_MS;
  const firstBucketStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS - (REPLAY_STATS_BUCKET_COUNT - 1) * HOUR_MS;
  const buckets = Array.from({ length: REPLAY_STATS_BUCKET_COUNT }, (_, index) => {
    const start = firstBucketStart + index * HOUR_MS;
    return { start: Math.floor(start / 1000), label: formatBucketLabel(start), count: 0 };
  });

  let games = 0;
  for (const item of items) {
    if (!Number.isFinite(item.time)) {
      continue;
    }
    const timeMs = item.time * 1000;
    if (timeMs < cutoffMs || timeMs > nowMs) {
      continue;
    }
    games += 1;
    // 24 个点以当前自然小时为末端；滚动窗口起点落在首个 bucket 之前时归入首点，
    // 避免整点 cutoff 的合法对局无法在图表中体现。
    const index = Math.max(
      0,
      Math.min(buckets.length - 1, Math.floor((timeMs - firstBucketStart) / HOUR_MS)),
    );
    buckets[index].count += 1;
  }

  return { games, buckets };
}
