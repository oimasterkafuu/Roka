const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * 华夏地图开放窗口：每年中国国庆假期（10 月 1 日至 10 月 7 日，含全天）。
 * 使用传入 Date 的绝对时间转换到 Asia/Shanghai，便于固定时间测试且不受服务器时区影响。
 */
export const isHuaxiaSeasonActive = (date: Date): boolean => {
  const parts = SHANGHAI_DATE_FORMATTER.formatToParts(date);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  return month === 10 && day >= 1 && day <= 7;
};
