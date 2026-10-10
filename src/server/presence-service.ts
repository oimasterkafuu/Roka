/**
 * 统一在线状态模型：「用户最近一次有效请求/动作时间」是唯一事实来源。
 *
 * - touch：任何已认证的 HTTP 请求（/api/online 自身除外，避免自我维持）与
 *   任何 socket 事件（连接建立、对局操作、房间心跳等）都刷新活动时间；
 *   bot 连接（ROKA_BOT_TOKENS 合成用户 / 服务端托管 bot）由调用方排除，不计入。
 * - 在线：最近 onlineWindowMs 内有活动；「最后在线」= 该活动时间戳；
 *   在线人数 = 在线窗口内的去重用户数。
 * - 持久化：touch 按 persistIntervalMs 节流回调 persist（落盘 lastSeenAt）；
 *   sweep 对刚掉出在线窗口的用户兜底落盘一次。重启后由 seed 从落盘数据恢复。
 */

interface PresenceRecord {
  /** 展示用用户名（保留注册大小写）。 */
  username: string;
  /** 最近一次有效请求/动作时间（毫秒时间戳），即「最后在线」。 */
  lastSeenAt: number;
  /** 上次落盘时的 lastSeenAt（用于节流与兜底判断）。 */
  persistedAt: number;
}

interface PresenceSeedEntry {
  username: string;
  lastSeenAt: number;
}

interface PresenceServiceOptions {
  /** 在线窗口：最近这么久内有活动视为在线。默认 5 分钟。 */
  onlineWindowMs?: number;
  /** lastSeenAt 落盘节流间隔（每用户）。默认 60 秒。 */
  persistIntervalMs?: number;
  /** 时钟（测试可注入假时钟）。 */
  now?: () => number;
  /** 落盘回调（fire-and-forget，内部异常由调用方吞掉）。 */
  persist?: (username: string, lastSeenAt: number) => void;
}

const DEFAULT_ONLINE_WINDOW_MS = 5 * 60_000;
const DEFAULT_PERSIST_INTERVAL_MS = 60_000;

class PresenceService {
  private readonly onlineWindowMs: number;

  private readonly persistIntervalMs: number;

  private readonly now: () => number;

  private readonly persistFn: ((username: string, lastSeenAt: number) => void) | null;

  /** 键为归一化用户名（小写），值为活动记录。 */
  private readonly records = new Map<string, PresenceRecord>();

  /** 当前处于在线窗口内的用户（归一化键），由 touch/sweep 维护。 */
  private readonly onlineKeys = new Set<string>();

  constructor(options: PresenceServiceOptions = {}) {
    this.onlineWindowMs = options.onlineWindowMs ?? DEFAULT_ONLINE_WINDOW_MS;
    this.persistIntervalMs = options.persistIntervalMs ?? DEFAULT_PERSIST_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.persistFn = options.persist ?? null;
  }

  /** 重启恢复：从落盘的 lastSeenAt 重建内存表（视为已落盘，不再触发 persist）。 */
  seed(entries: PresenceSeedEntry[]): void {
    for (const entry of entries) {
      if (typeof entry.lastSeenAt !== 'number' || !Number.isFinite(entry.lastSeenAt)) {
        continue;
      }
      const key = this.normalize(entry.username);
      this.records.set(key, {
        username: entry.username,
        lastSeenAt: entry.lastSeenAt,
        persistedAt: entry.lastSeenAt,
      });
      if (this.now() - entry.lastSeenAt < this.onlineWindowMs) {
        this.onlineKeys.add(key);
      }
    }
  }

  /**
   * 记录一次有效请求/动作。返回 true 表示该用户由离线转为在线
   * （调用方据此广播上线通知）。
   */
  touch(usernameInput: string): boolean {
    const username = String(usernameInput ?? '').trim();
    if (!username) {
      return false;
    }
    const key = this.normalize(username);
    const now = this.now();
    const wasOnline = this.onlineKeys.has(key);
    let record = this.records.get(key);
    if (!record) {
      record = { username, lastSeenAt: now, persistedAt: 0 };
      this.records.set(key, record);
    } else {
      record.username = username;
      record.lastSeenAt = now;
    }
    this.onlineKeys.add(key);
    if (now - record.persistedAt >= this.persistIntervalMs) {
      this.persistRecord(record);
    }
    return !wasOnline;
  }

  isOnline(usernameInput: string): boolean {
    const record = this.records.get(this.normalize(usernameInput));
    return Boolean(record) && this.now() - (record?.lastSeenAt ?? 0) < this.onlineWindowMs;
  }

  /** 在线人数：在线窗口内的去重用户数。 */
  countOnline(): number {
    return this.onlineKeys.size;
  }

  /** 「最后在线」时间戳；无记录返回 null。 */
  getLastSeen(usernameInput: string): number | null {
    return this.records.get(this.normalize(usernameInput))?.lastSeenAt ?? null;
  }

  /** 全部用户按最后活动时间倒序的列表（含当前在线者），即首页「在线」列表。 */
  listByActivity(limit: number): PresenceSeedEntry[] {
    const capped = Math.max(1, Math.min(100, Math.floor(limit) || 10));
    const entries: PresenceSeedEntry[] = [];
    for (const record of this.records.values()) {
      entries.push({ username: record.username, lastSeenAt: record.lastSeenAt });
    }
    entries.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return entries.slice(0, capped);
  }

  /**
   * 周期扫描：把掉出在线窗口的用户移出在线集并兜底落盘（「最后在线」最多滞后
   * 一个节流间隔）。返回本轮转为离线的用户名列表（调用方据此广播下线通知）。
   */
  sweep(): string[] {
    const now = this.now();
    const expired: string[] = [];
    for (const key of this.onlineKeys) {
      const record = this.records.get(key);
      if (!record || now - record.lastSeenAt < this.onlineWindowMs) {
        continue;
      }
      this.onlineKeys.delete(key);
      expired.push(record.username);
      if (record.persistedAt < record.lastSeenAt) {
        this.persistRecord(record);
      }
    }
    return expired;
  }

  private persistRecord(record: PresenceRecord): void {
    record.persistedAt = record.lastSeenAt;
    this.persistFn?.(record.username, record.lastSeenAt);
  }

  private normalize(username: string): string {
    return username.trim().toLowerCase();
  }
}

export { PresenceService };
export type { PresenceSeedEntry, PresenceServiceOptions };
