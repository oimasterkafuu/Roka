import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { serialize } from 'node:v8';
import type { DisciplineType } from './server/auto-ban-policy';
import type { FeedPost, ReplayListItem } from './types';
import {
  CoalescingFileWriter,
  decodeBinary,
  encodeRawBinary,
  isMissingFileError,
  readFileWithBackup,
} from './binary-store';

interface RatingHistoryPoint {
  t: number;
  r: number;
}

export interface BanRecord {
  startedAt: number;
  bannedUntil: number;
  type: DisciplineType | 'manual';
  reason: string;
  triggeredAt: number;
  evidence: string;
}

export interface DisciplineRecord {
  occurredAt: number;
  type: DisciplineType | 'normal_surrender' | 'leave' | 'disconnect_timeout';
  turn: number;
  elapsedMs: number;
  evidence: string;
}

interface StoredUser {
  username: string;
  passwordSalt: string;
  passwordHash: string;
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  rating?: number;
  ratingGames?: number;
  // 对局积分；旧数据缺省时按 0 处理。
  points?: number;
  isAdmin?: boolean;
  // 超级管理员：仅首个注册用户一人，不可被剥夺、不可被封禁。
  // 旧数据无此字段，启动时由 migrateRoles 把首个用户（原有 admin）升级为超管（向后兼容）。
  isSuperAdmin?: boolean;
  // 封禁截止时间的 Unix 毫秒时间戳；-1 表示永久封禁；缺省表示未封禁。
  // 到期不解数据，读取时惰性判定为已解除（见 getBanStatus）。
  bannedUntil?: number;
  currentBan?: BanRecord;
  banHistory?: BanRecord[];
  disciplineHistory?: DisciplineRecord[];
  automaticBanCount?: number;
  ratingHistory?: RatingHistoryPoint[];
  // 最后在线时间：用户最近一次有效请求/动作的时间，由 presence-service 统一维护
  // （本字段只是它的持久化落盘）。旧数据无此字段，读取时按 undefined 处理（向后兼容）。
  lastSeenAt?: number;
}

export interface PublicProfile {
  username: string;
  rating: number;
  ratingGames: number;
  provisional: boolean;
  points: number;
  level: UserLevelProgress;
  ratingRawRank: number;
  ratingDisplayRank: string;
  createdAt: number;
  isAdmin: boolean;
  ratingHistory: RatingHistoryPoint[];
}

export interface UserLevelProgress {
  level: number;
  points: number;
  currentLevelPoints: number;
  nextLevelPoints: number | null;
  progress: number;
}

export interface PointsRankEntry {
  username: string;
  points: number;
  level: UserLevelProgress;
  rawRank: number;
  displayRank: string;
}

export interface TopRatedEntry {
  username: string;
  rating: number;
  ratingGames: number;
  provisional: boolean;
}

export interface AdminUserEntry {
  username: string;
  rating: number;
  ratingGames: number;
  provisional: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  /** -1 表示永久封禁；null 表示未封禁。 */
  bannedUntil: number | null;
  ban: BanRecord | null;
  banHistory: BanRecord[];
}

export interface BanStatus {
  banned: boolean;
  /** -1 表示永久封禁；banned=false 时为 null。 */
  bannedUntil: number | null;
  ban: BanRecord | null;
}

const formatBanDeadline = (timestamp: number): string => {
  const d = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const formatBanMessage = (banStatus: BanStatus): string => {
  const reason = banStatus.ban?.reason?.trim() || '管理员封禁';
  const deadline = banStatus.bannedUntil === -1 ? '永久' : formatBanDeadline(banStatus.bannedUntil ?? 0);
  return `该账号已被封禁。理由：${reason}。解除时间：${deadline}。`;
};

interface UserFile {
  users: StoredUser[];
  pointsMigrationVersion?: number;
}

/**
 * 统一 Rating 初始分（不区分 1v1 与 FFA）。
 */
const DEFAULT_RATING = 1200;

export const GAME_BASE_POINTS = 40;
export const RANK_BONUS_MIN = 40;
export const RANK_BONUS_MAX = 100;
export const POST_POINTS = 30;
export const RECEIVED_INTERACTION_POINTS = 10;
export const LIKE_POINTS = 10;
export const COMMENT_POINTS = 20;
export const POINTS_MIGRATION_VERSION = 1;
/** @deprecated 使用 getGamePoints(place, totalPlayers)。 */
export const GAME_POINTS = GAME_BASE_POINTS;
export const LEVEL_THRESHOLDS = [0, 16, 108, 288, 1000, 2888] as const;

export const getGamePoints = (place: number, totalPlayers: number): number => {
  const normalizedPlace = Math.max(1, Math.floor(place));
  const normalizedPlayers = Math.max(normalizedPlace, Math.floor(totalPlayers));
  const rankBonus = Math.min(
    RANK_BONUS_MAX,
    Math.max(RANK_BONUS_MIN, RANK_BONUS_MIN + 10 * (normalizedPlayers - normalizedPlace)),
  );
  return GAME_BASE_POINTS + rankBonus;
};

const addPoints = (points: Map<string, number>, username: string, value: number): void => {
  const key = username.trim().toLowerCase();
  if (key) points.set(key, (points.get(key) ?? 0) + value);
};

export const calculateHistoricalPoints = (
  replays: ReplayListItem[],
  posts: FeedPost[],
): Map<string, number> => {
  const points = new Map<string, number>();
  for (const replay of replays) {
    const players = [
      ...new Set(
        (replay.rank ?? [])
          .filter((username) => typeof username === 'string')
          .map((username) => username.trim().toLowerCase()),
      ),
    ];
    players.forEach((username, index) =>
      addPoints(points, username, getGamePoints(index + 1, players.length)),
    );
  }
  for (const post of posts) {
    addPoints(points, post.author, POST_POINTS);
    for (const username of post.likes ?? []) {
      if (username.trim().toLowerCase() !== post.author.trim().toLowerCase()) {
        addPoints(points, post.author, RECEIVED_INTERACTION_POINTS);
        addPoints(points, username, LIKE_POINTS);
      }
    }
    for (const comment of post.comments ?? []) {
      addPoints(points, post.author, RECEIVED_INTERACTION_POINTS);
      addPoints(points, comment.author, COMMENT_POINTS);
    }
  }
  return points;
};

export const getUserLevelProgress = (rawPoints: number): UserLevelProgress => {
  const points = Number.isFinite(rawPoints) ? Math.max(0, Math.floor(rawPoints)) : 0;
  let levelIndex = 0;
  for (let index = 1; index < LEVEL_THRESHOLDS.length; index += 1) {
    if (points < LEVEL_THRESHOLDS[index]) {
      break;
    }
    levelIndex = index;
  }
  const currentLevelPoints = LEVEL_THRESHOLDS[levelIndex];
  const nextLevelPoints = LEVEL_THRESHOLDS[levelIndex + 1] ?? null;
  const progress =
    nextLevelPoints === null
      ? 1
      : (points - currentLevelPoints) / Math.max(1, nextLevelPoints - currentLevelPoints);
  return {
    level: levelIndex + 1,
    points,
    currentLevelPoints,
    nextLevelPoints,
    progress: Math.max(0, Math.min(1, progress)),
  };
};

export const displayPointsRank = (rawRank: number): string => {
  if (!Number.isFinite(rawRank) || rawRank < 1) return '-';
  const rank = Math.floor(rawRank);
  if (rank <= 20) return String(rank);
  if (rank <= 50) return '20+';
  if (rank <= 100) return '50+';
  if (rank <= 200) return '100+';
  if (rank <= 500) return '200+';
  return '500+';
};

export const displayRatingRank = (rawRank: number): string => {
  if (!Number.isFinite(rawRank) || rawRank < 1) return '-';
  const rank = Math.floor(rawRank);
  if (rank <= 20) return String(rank);
  if (rank <= 50) return '20+';
  if (rank <= 100) return '50+';
  if (rank <= 200) return '100+';
  return '200+';
};

/**
 * Codeforces 风格新手 Rating：内部从 DEFAULT_RATING 起算并参与 ELO 结算，
 * 对外显示分从 0 起步，按 1200 / 2^对局数 的 delta 快速逼近真实分后渐渐放慢。
 */
const toDisplayRating = (rating: number, ratingGames: number): number => {
  if (!Number.isFinite(rating) || !Number.isFinite(ratingGames) || ratingGames <= 0) {
    return 0;
  }
  const shift = DEFAULT_RATING / 2 ** ratingGames;
  return Math.max(0, Math.round(rating - shift));
};

/**
 * 新手期未定型：还有基准分未发完（1200 / 2^对局数 >= 1）且显示分尚未到 1200。
 * 用于前端在 rating 数字右侧加「?」提示。
 */
export const isProvisionalRating = (rating: number, ratingGames: number): boolean => {
  if (!Number.isFinite(rating) || !Number.isFinite(ratingGames)) {
    return false;
  }
  return toDisplayRating(rating, ratingGames) < DEFAULT_RATING && DEFAULT_RATING / 2 ** ratingGames >= 1;
};

const RATING_HISTORY_MAX = 1000;

/**
 * 排行榜不活跃下榜阈值：≥7 天没有任何活动即从榜单隐藏（rating 数据保留，
 * 重新活跃后立即回榜）。活动 = socket 上线/下线（lastSeenAt）或账号字段变更
 * （updatedAt，对局结算、登录轮换会话等都会刷新）。
 */
export const LEADERBOARD_INACTIVITY_MS = 7 * 24 * 3600 * 1000;

/**
 * 用户最后活动时间：取 lastSeenAt（socket 上线/下线）与 updatedAt（对局结算、
 * 登录等账号变更）的较大者。bot 账号同样适用——天天对局的 bot 经结算刷新
 * updatedAt 保持活跃；停用超过阈值的 bot 也会下榜（与人类账号同一语义）。
 */
export const getLastActiveAt = (user: { lastSeenAt?: number; updatedAt: number }): number =>
  Math.max(user.updatedAt, user.lastSeenAt ?? 0);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const toBanRecord = (value: unknown): BanRecord | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value.startedAt !== 'number' ||
    typeof value.bannedUntil !== 'number' ||
    typeof value.type !== 'string' ||
    typeof value.reason !== 'string' ||
    typeof value.triggeredAt !== 'number' ||
    typeof value.evidence !== 'string'
  )
    return null;
  return {
    startedAt: value.startedAt,
    bannedUntil: value.bannedUntil,
    type: value.type as BanRecord['type'],
    reason: value.reason,
    triggeredAt: value.triggeredAt,
    evidence: value.evidence,
  };
};

const toDisciplineRecord = (value: unknown): DisciplineRecord | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value.occurredAt !== 'number' ||
    typeof value.type !== 'string' ||
    typeof value.turn !== 'number' ||
    typeof value.elapsedMs !== 'number' ||
    typeof value.evidence !== 'string'
  )
    return null;
  return {
    occurredAt: value.occurredAt,
    type: value.type as DisciplineType,
    turn: value.turn,
    elapsedMs: value.elapsedMs,
    evidence: value.evidence,
  };
};

const toStoredUser = (value: unknown): StoredUser | null => {
  if (!isRecord(value)) {
    return null;
  }
  const username = value.username;
  const passwordSalt = value.passwordSalt;
  const passwordHash = value.passwordHash;
  const sessionId = value.sessionId;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  if (
    typeof username !== 'string' ||
    typeof passwordSalt !== 'string' ||
    typeof passwordHash !== 'string' ||
    (sessionId !== null && typeof sessionId !== 'string') ||
    typeof createdAt !== 'number' ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(updatedAt)
  ) {
    return null;
  }
  const normalizedSessionId: string | null = sessionId === null ? null : (sessionId as string);
  const rating = value.rating;
  const ratingGames = value.ratingGames;
  const points = value.points;
  const lastSeenAt = value.lastSeenAt;
  const bannedUntil = value.bannedUntil;
  const currentBan = toBanRecord(value.currentBan);
  const banHistory = (Array.isArray(value.banHistory) ? value.banHistory : [])
    .map(toBanRecord)
    .filter((item): item is BanRecord => item !== null);
  const disciplineHistory = (Array.isArray(value.disciplineHistory) ? value.disciplineHistory : [])
    .map(toDisciplineRecord)
    .filter((item): item is DisciplineRecord => item !== null);
  const ratingHistoryRaw = Array.isArray(value.ratingHistory) ? value.ratingHistory : [];
  const ratingHistory: RatingHistoryPoint[] = [];
  for (const point of ratingHistoryRaw) {
    if (
      isRecord(point) &&
      typeof point.t === 'number' &&
      Number.isFinite(point.t) &&
      typeof point.r === 'number' &&
      Number.isFinite(point.r)
    ) {
      ratingHistory.push({ t: point.t, r: point.r });
    }
  }
  return {
    username,
    passwordSalt,
    passwordHash,
    sessionId: normalizedSessionId,
    createdAt,
    updatedAt,
    rating: typeof rating === 'number' && Number.isFinite(rating) ? rating : undefined,
    ratingGames: typeof ratingGames === 'number' && Number.isFinite(ratingGames) ? ratingGames : undefined,
    points: typeof points === 'number' && Number.isFinite(points) ? points : undefined,
    isAdmin: value.isAdmin === true ? true : undefined,
    isSuperAdmin: value.isSuperAdmin === true ? true : undefined,
    bannedUntil: typeof bannedUntil === 'number' && Number.isFinite(bannedUntil) ? bannedUntil : undefined,
    currentBan: currentBan ?? undefined,
    banHistory,
    disciplineHistory,
    automaticBanCount:
      typeof value.automaticBanCount === 'number' && Number.isFinite(value.automaticBanCount)
        ? value.automaticBanCount
        : undefined,
    ratingHistory,
    lastSeenAt: typeof lastSeenAt === 'number' && Number.isFinite(lastSeenAt) ? lastSeenAt : undefined,
  };
};

const parseUserFile = (value: unknown): UserFile => {
  if (!isRecord(value) || !Array.isArray(value.users)) {
    throw new Error('用户数据结构无效。');
  }
  const users: StoredUser[] = [];
  for (const item of value.users) {
    const parsed = toStoredUser(item);
    if (parsed) {
      users.push(parsed);
    }
  }
  return {
    users,
    pointsMigrationVersion:
      typeof value.pointsMigrationVersion === 'number' && Number.isFinite(value.pointsMigrationVersion)
        ? value.pointsMigrationVersion
        : 0,
  };
};

const decodeUserFileBinary = async (content: Buffer): Promise<UserFile> => decodeBinary<UserFile>(content);

export class UserStore {
  private readonly binaryFilePath: string;

  private usersByKey = new Map<string, StoredUser>();

  private pointsMigrationVersion = 0;

  // 写盘合并串行化：突发连续写入只压缩落盘一次（见 binary-store）。
  private readonly writer: CoalescingFileWriter;

  constructor(dataDir: string) {
    this.binaryFilePath = path.join(dataDir, 'users.bin');
    this.writer = new CoalescingFileWriter(this.binaryFilePath);
  }

  async ensureReady(): Promise<void> {
    await mkdir(path.dirname(this.binaryFilePath), { recursive: true });

    let binaryError: unknown = null;
    try {
      const userFile = await this.loadFromBinary();
      this.replaceUsers(userFile.users);
      this.pointsMigrationVersion = userFile.pointsMigrationVersion ?? 0;
      if (await this.migrateRoles()) {
        return;
      }
      return;
    } catch (error) {
      if (!isMissingFileError(error)) {
        binaryError = error;
      }
    }

    if (binaryError) {
      throw new Error('users.bin 解析失败。', { cause: binaryError });
    }

    await this.persist();
  }

  validateUsernameOrThrow(input: string): string {
    const username = input.trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      throw new Error('用户名需为 3-20 位，只能包含字母、数字和下划线。');
    }
    return username;
  }

  validatePasswordOrThrow(password: string): void {
    if (password.length < 6 || password.length > 72) {
      throw new Error('密码长度必须在 6 到 72 位之间。');
    }
  }

  async register(usernameInput: string, password: string): Promise<string> {
    const username = this.validateUsernameOrThrow(usernameInput);
    this.validatePasswordOrThrow(password);

    const key = this.normalize(username);
    if (this.usersByKey.has(key)) {
      throw new Error('用户名已存在。');
    }

    const salt = randomBytes(16).toString('hex');
    const user: StoredUser = {
      username,
      passwordSalt: salt,
      passwordHash: this.hashPassword(password, salt),
      sessionId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rating: DEFAULT_RATING,
      ratingGames: 0,
      points: 0,
      // 首个注册用户 = 超级管理员（同时拥有管理员权限）。
      isAdmin: this.usersByKey.size === 0 ? true : undefined,
      isSuperAdmin: this.usersByKey.size === 0 ? true : undefined,
      ratingHistory: [],
    };

    this.usersByKey.set(key, user);
    await this.persist();
    return user.username;
  }

  verifyPassword(usernameInput: string, password: string): string | null {
    const key = this.normalize(usernameInput);
    const user = this.usersByKey.get(key);
    if (!user) {
      return null;
    }

    const hashBuffer = Buffer.from(user.passwordHash, 'hex');
    const compare = Buffer.from(this.hashPassword(password, user.passwordSalt), 'hex');
    if (hashBuffer.length !== compare.length) {
      return null;
    }

    if (!timingSafeEqual(hashBuffer, compare)) {
      return null;
    }

    return user.username;
  }

  async rotateSession(usernameInput: string): Promise<string> {
    const key = this.normalize(usernameInput);
    const user = this.usersByKey.get(key);
    if (!user) {
      throw new Error('用户不存在。');
    }

    user.sessionId = randomBytes(24).toString('base64url');
    user.updatedAt = Date.now();
    await this.persist();
    return user.sessionId;
  }

  async clearSession(usernameInput: string): Promise<void> {
    const key = this.normalize(usernameInput);
    const user = this.usersByKey.get(key);
    if (!user) {
      return;
    }

    user.sessionId = null;
    user.updatedAt = Date.now();
    await this.persist();
  }

  isSessionValid(usernameInput: string, sessionId: string): boolean {
    const key = this.normalize(usernameInput);
    const user = this.usersByKey.get(key);
    return Boolean(user && user.sessionId && user.sessionId === sessionId);
  }

  getRating(usernameInput: string): { rating: number; ratingGames: number } {
    const user = this.usersByKey.get(this.normalize(usernameInput));
    return {
      rating: user?.rating ?? DEFAULT_RATING,
      ratingGames: user?.ratingGames ?? 0,
    };
  }

  getDisplayRating(usernameInput: string): { rating: number; ratingGames: number; provisional: boolean } {
    const { rating, ratingGames } = this.getRating(usernameInput);
    return {
      rating: toDisplayRating(rating, ratingGames),
      ratingGames,
      provisional: isProvisionalRating(rating, ratingGames),
    };
  }

  getPoints(usernameInput: string): number {
    const user = this.usersByKey.get(this.normalize(usernameInput));
    return typeof user?.points === 'number' && Number.isFinite(user.points) ? Math.max(0, user.points) : 0;
  }

  async applyPointsUpdates(updates: Array<{ username: string; points: number }>): Promise<void> {
    let changed = false;
    for (const update of updates) {
      const user = this.usersByKey.get(this.normalize(update.username));
      if (!user || !Number.isFinite(update.points)) {
        continue;
      }
      user.points = Math.max(0, this.getPoints(user.username) + update.points);
      user.updatedAt = Date.now();
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
  }

  async initializeHistoricalPoints(replays: ReplayListItem[], posts: FeedPost[]): Promise<void> {
    if (this.pointsMigrationVersion >= POINTS_MIGRATION_VERSION) {
      return;
    }
    const historicalPoints = calculateHistoricalPoints(replays, posts);
    for (const user of this.usersByKey.values()) {
      user.points = Math.max(0, historicalPoints.get(this.normalize(user.username)) ?? 0);
    }
    this.pointsMigrationVersion = POINTS_MIGRATION_VERSION;
    await this.persist();
  }

  listPointsRank(limit = 100): PointsRankEntry[] {
    const capped = Math.max(1, Math.min(1000, Math.floor(limit) || 100));
    const users = [...this.usersByKey.values()].sort((a, b) => {
      const pointDiff = this.getPoints(b.username) - this.getPoints(a.username);
      return pointDiff || a.username.localeCompare(b.username);
    });
    return users.slice(0, capped).map((user, index) => {
      const points = this.getPoints(user.username);
      const rawRank = index + 1;
      return {
        username: user.username,
        points,
        level: getUserLevelProgress(points),
        rawRank,
        displayRank: displayPointsRank(rawRank),
      };
    });
  }

  getPointsRank(usernameInput: string): PointsRankEntry | null {
    const username = this.normalize(usernameInput);
    const users = [...this.usersByKey.values()].sort((a, b) => {
      const pointDiff = this.getPoints(b.username) - this.getPoints(a.username);
      return pointDiff || a.username.localeCompare(b.username);
    });
    const index = users.findIndex((user) => this.normalize(user.username) === username);
    if (index < 0) return null;
    const user = users[index];
    const points = this.getPoints(user.username);
    const rawRank = index + 1;
    return {
      username: user.username,
      points,
      level: getUserLevelProgress(points),
      rawRank,
      displayRank: displayPointsRank(rawRank),
    };
  }

  getRatingRank(usernameInput: string): { rawRank: number; displayRank: string } | null {
    const username = this.normalize(usernameInput);
    const users = [...this.usersByKey.values()]
      .filter((user) => (user.ratingGames ?? 0) > 0)
      .sort((a, b) => {
        const ratingDiff =
          toDisplayRating(b.rating ?? DEFAULT_RATING, b.ratingGames ?? 0) -
          toDisplayRating(a.rating ?? DEFAULT_RATING, a.ratingGames ?? 0);
        return ratingDiff || a.createdAt - b.createdAt || a.username.localeCompare(b.username);
      });
    const index = users.findIndex((user) => this.normalize(user.username) === username);
    if (index < 0) return null;
    const rawRank = index + 1;
    return { rawRank, displayRank: displayRatingRank(rawRank) };
  }

  async applyRatingUpdates(updates: Array<{ username: string; delta: number }>): Promise<void> {
    let changed = false;
    for (const update of updates) {
      const user = this.usersByKey.get(this.normalize(update.username));
      if (!user || !Number.isFinite(update.delta)) {
        continue;
      }
      user.rating = Math.round(((user.rating ?? DEFAULT_RATING) + update.delta) * 10) / 10;
      user.ratingGames = (user.ratingGames ?? 0) + 1;
      if (!Array.isArray(user.ratingHistory)) {
        user.ratingHistory = [];
      }
      // 历史曲线记录对外显示分，保持与个人主页展示一致。
      user.ratingHistory.push({ t: Date.now(), r: toDisplayRating(user.rating, user.ratingGames) });
      if (user.ratingHistory.length > RATING_HISTORY_MAX) {
        user.ratingHistory = user.ratingHistory.slice(-RATING_HISTORY_MAX);
      }
      user.updatedAt = Date.now();
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
  }

  isAdminUser(usernameInput: string): boolean {
    const user = this.usersByKey.get(this.normalize(usernameInput));
    return user?.isAdmin === true;
  }

  isSuperAdminUser(usernameInput: string): boolean {
    const user = this.usersByKey.get(this.normalize(usernameInput));
    return user?.isSuperAdmin === true;
  }

  /**
   * 封禁状态惰性判定：到期即视为自动解除（顺手清字段并落盘，无后台定时器）。
   */
  getBanStatus(usernameInput: string): BanStatus {
    const user = this.usersByKey.get(this.normalize(usernameInput));
    if (!user || typeof user.bannedUntil !== 'number') {
      return { banned: false, bannedUntil: null, ban: null };
    }
    if (user.bannedUntil < 0 || user.bannedUntil > Date.now()) {
      return { banned: true, bannedUntil: user.bannedUntil, ban: user.currentBan ?? null };
    }
    user.bannedUntil = undefined;
    user.currentBan = undefined;
    void this.persist().catch(() => undefined);
    return { banned: false, bannedUntil: null, ban: null };
  }

  isBanned(usernameInput: string): boolean {
    return this.getBanStatus(usernameInput).banned;
  }

  async applyBan(
    usernameInput: string,
    bannedUntil: number,
    details: {
      type: BanRecord['type'];
      reason: string;
      triggeredAt?: number;
      evidence?: string;
    },
  ): Promise<BanRecord> {
    const user = this.usersByKey.get(this.normalize(usernameInput));
    if (!user) throw new Error('用户不存在。');
    if (user.isSuperAdmin === true) throw new Error('不能封禁超级管理员。');
    const now = Date.now();
    const record: BanRecord = {
      startedAt: now,
      bannedUntil,
      type: details.type,
      reason: details.reason,
      triggeredAt: details.triggeredAt ?? now,
      evidence: details.evidence ?? '',
    };
    user.bannedUntil = bannedUntil;
    user.currentBan = record;
    user.banHistory = [...(user.banHistory ?? []), record].slice(-50);
    if (details.type !== 'manual') {
      user.automaticBanCount = (user.automaticBanCount ?? 0) + 1;
    }
    user.updatedAt = now;
    await this.persist();
    return record;
  }

  async applyAutomaticDiscipline(
    usernameInput: string,
    bannedUntil: number,
    type: DisciplineType,
    triggeredAt: number,
    evidence: string,
  ): Promise<BanRecord> {
    return this.applyBan(usernameInput, bannedUntil, {
      type,
      reason: type === 'afk' ? '连续挂机' : '消极游戏',
      triggeredAt,
      evidence,
    });
  }

  /** 旧 API 兼容：管理员调用方未提供理由时仍记录为手动封禁。 */
  async banUser(usernameInput: string, bannedUntil: number, reason = '管理员手动封禁'): Promise<void> {
    await this.applyBan(usernameInput, bannedUntil, {
      type: 'manual',
      reason,
    });
  }

  async unbanUser(usernameInput: string): Promise<void> {
    const user = this.usersByKey.get(this.normalize(usernameInput));
    if (!user) throw new Error('用户不存在。');
    user.bannedUntil = undefined;
    user.currentBan = undefined;
    user.updatedAt = Date.now();
    await this.persist();
  }

  async recordDisciplineEvent(usernameInput: string, event: DisciplineRecord): Promise<DisciplineRecord[]> {
    const user = this.usersByKey.get(this.normalize(usernameInput));
    if (!user) return [];
    user.disciplineHistory = [...(user.disciplineHistory ?? []), event].slice(-100);
    await this.persist();
    return user.disciplineHistory;
  }

  listDisciplineEvents(usernameInput: string): DisciplineRecord[] {
    return [...(this.usersByKey.get(this.normalize(usernameInput))?.disciplineHistory ?? [])];
  }

  getAutomaticBanCount(usernameInput: string): number {
    return this.usersByKey.get(this.normalize(usernameInput))?.automaticBanCount ?? 0;
  }

  /**
   * 授予/撤销管理员权限（调用方需已校验操作者是超级管理员）。
   * 超级管理员自身的权限不可修改。
   */
  async setAdmin(usernameInput: string, isAdmin: boolean): Promise<void> {
    const user = this.usersByKey.get(this.normalize(usernameInput));
    if (!user) {
      throw new Error('用户不存在。');
    }
    if (user.isSuperAdmin === true) {
      throw new Error('不能修改超级管理员的权限。');
    }
    user.isAdmin = isAdmin ? true : undefined;
    user.updatedAt = Date.now();
    await this.persist();
  }

  /**
   * 后台管理页用户列表：按注册时间升序，rating 为对外显示分。
   */
  listUsersForAdmin(): AdminUserEntry[] {
    const entries: AdminUserEntry[] = [];
    for (const user of this.usersByKey.values()) {
      const rating = user.rating ?? DEFAULT_RATING;
      const ratingGames = user.ratingGames ?? 0;
      const ban = this.getBanStatus(user.username);
      entries.push({
        username: user.username,
        rating: toDisplayRating(rating, ratingGames),
        ratingGames,
        provisional: isProvisionalRating(rating, ratingGames),
        createdAt: user.createdAt,
        lastSeenAt:
          typeof user.lastSeenAt === 'number' && Number.isFinite(user.lastSeenAt) ? user.lastSeenAt : null,
        isAdmin: user.isAdmin === true,
        isSuperAdmin: user.isSuperAdmin === true,
        bannedUntil: ban.banned ? ban.bannedUntil : null,
        ban: ban.banned ? ban.ban : null,
        banHistory: (user.banHistory ?? []).slice(-10),
      });
    }
    entries.sort((a, b) => a.createdAt - b.createdAt);
    return entries;
  }

  getPublicProfile(usernameInput: string): PublicProfile | null {
    const user = this.usersByKey.get(this.normalize(usernameInput));
    if (!user) {
      return null;
    }
    const rating = user.rating ?? DEFAULT_RATING;
    const ratingGames = user.ratingGames ?? 0;
    const points = this.getPoints(user.username);
    const ratingRank = this.getRatingRank(user.username);
    return {
      username: user.username,
      rating: toDisplayRating(rating, ratingGames),
      ratingGames,
      provisional: isProvisionalRating(rating, ratingGames),
      points,
      level: getUserLevelProgress(points),
      ratingRawRank: ratingRank?.rawRank ?? 0,
      ratingDisplayRank: ratingRank?.displayRank ?? '-',
      createdAt: user.createdAt,
      isAdmin: user.isAdmin === true,
      ratingHistory: Array.isArray(user.ratingHistory) ? [...user.ratingHistory] : [],
    };
  }

  listTopRated(limit: number, now: number = Date.now()): TopRatedEntry[] {
    const capped = Math.max(1, Math.min(100, Math.floor(limit) || 10));
    const entries: TopRatedEntry[] = [];
    for (const user of this.usersByKey.values()) {
      const ratingGames = user.ratingGames ?? 0;
      if (ratingGames <= 0) {
        continue;
      }
      // 不活跃下榜：≥7 天无任何活动（对局/上线等）即隐藏，重新活跃后回榜。
      if (now - getLastActiveAt(user) >= LEADERBOARD_INACTIVITY_MS) {
        continue;
      }
      entries.push({
        username: user.username,
        rating: toDisplayRating(user.rating ?? DEFAULT_RATING, ratingGames),
        ratingGames,
        provisional: isProvisionalRating(user.rating ?? DEFAULT_RATING, ratingGames),
      });
    }
    entries.sort((a, b) => b.rating - a.rating);
    return entries.slice(0, capped);
  }

  /**
   * 写入用户「最后在线」时间（presence-service 的落盘回调；值由它统一计算与节流）。
   * 不写 updatedAt：它只是账号字段变更时间，与在线状态无关。
   */
  async setLastSeenAt(usernameInput: string, lastSeenAt: number): Promise<void> {
    const user = this.usersByKey.get(this.normalize(usernameInput));
    if (!user || !Number.isFinite(lastSeenAt)) {
      return;
    }
    user.lastSeenAt = lastSeenAt;
    await this.persist();
  }

  /**
   * 全部用户的「最后在线」落盘记录，供 presence-service 启动时 seed 恢复内存表。
   */
  listLastSeen(): { username: string; lastSeenAt: number }[] {
    const entries: { username: string; lastSeenAt: number }[] = [];
    for (const user of this.usersByKey.values()) {
      if (typeof user.lastSeenAt !== 'number' || !Number.isFinite(user.lastSeenAt)) {
        continue;
      }
      entries.push({ username: user.username, lastSeenAt: user.lastSeenAt });
    }
    return entries;
  }

  /**
   * 角色迁移：首个注册用户固定为超级管理员（同时拥有 admin），其余用户摘除误挂的超管标记。
   * 旧数据里首个用户只有 isAdmin（无 isSuperAdmin），启动时自动升级；返回 true 表示已写盘。
   */
  private async migrateRoles(): Promise<boolean> {
    if (this.usersByKey.size === 0) {
      return false;
    }
    // Map 按文件顺序插入，即注册顺序；第一个即最早注册用户。
    const first = this.usersByKey.values().next().value;
    if (!first) {
      return false;
    }
    let changed = false;
    if (first.isAdmin !== true) {
      first.isAdmin = true;
      changed = true;
    }
    if (first.isSuperAdmin !== true) {
      first.isSuperAdmin = true;
      changed = true;
    }
    for (const user of this.usersByKey.values()) {
      if (user !== first && user.isSuperAdmin === true) {
        user.isSuperAdmin = undefined;
        changed = true;
      }
    }
    if (!changed) {
      return false;
    }
    await this.persist();
    return true;
  }

  private normalize(username: string): string {
    return username.trim().toLowerCase();
  }

  private replaceUsers(users: StoredUser[]): void {
    this.usersByKey = new Map(users.map((user) => [this.normalize(user.username), { ...user }]));
  }

  private async loadFromBinary(): Promise<UserFile> {
    const parsed = await readFileWithBackup(this.binaryFilePath, decodeUserFileBinary);
    return parseUserFile(parsed);
  }

  private hashPassword(password: string, salt: string): string {
    return scryptSync(password, salt, 64).toString('hex');
  }

  private persist(): Promise<void> {
    const data: UserFile = {
      users: [...this.usersByKey.values()],
      pointsMigrationVersion: this.pointsMigrationVersion,
    };
    // serialize 同步执行，调用时即拿到状态快照；brotli 压缩惰性执行，
    // 被合并丢弃的排队写不产生压缩开销。
    const raw = serialize(data);
    return this.writer.write(() => encodeRawBinary(raw));
  }
}
