import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress, constants as zlibConstants } from 'node:zlib';

interface RatingHistoryPoint {
  t: number;
  r: number;
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
  isAdmin?: boolean;
  ratingHistory?: RatingHistoryPoint[];
}

export interface PublicProfile {
  username: string;
  rating: number;
  ratingGames: number;
  provisional: boolean;
  createdAt: number;
  isAdmin: boolean;
  ratingHistory: RatingHistoryPoint[];
}

export interface TopRatedEntry {
  username: string;
  rating: number;
  ratingGames: number;
  provisional: boolean;
}

interface UserFile {
  users: StoredUser[];
}

const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

/**
 * 统一 Rating 初始分（不区分 1v1 与 FFA）。
 */
const DEFAULT_RATING = 1200;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isMissingFileError = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT',
  );

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
    isAdmin: value.isAdmin === true ? true : undefined,
    ratingHistory,
  };
};

const parseUserFile = (value: unknown): StoredUser[] => {
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
  return users;
};

const encodeUserFileBinary = async (value: UserFile): Promise<Buffer> => {
  const raw = serialize(value);
  return (await brotliCompressAsync(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
    },
  })) as Buffer;
};

const decodeUserFileBinary = async (content: Buffer): Promise<UserFile> => {
  const raw = (await brotliDecompressAsync(content)) as Buffer;
  return deserialize(raw) as UserFile;
};

export class UserStore {
  private readonly binaryFilePath: string;

  private usersByKey = new Map<string, StoredUser>();

  // 写盘串行化：persist 经 promise 链排队，避免并发写交错。
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.binaryFilePath = path.join(dataDir, 'users.bin');
  }

  async ensureReady(): Promise<void> {
    await mkdir(path.dirname(this.binaryFilePath), { recursive: true });

    let binaryError: unknown = null;
    try {
      const users = await this.loadFromBinary();
      this.replaceUsers(users);
      if (await this.migrateFirstAdmin()) {
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
      isAdmin: this.usersByKey.size === 0 ? true : undefined,
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

  getPublicProfile(usernameInput: string): PublicProfile | null {
    const user = this.usersByKey.get(this.normalize(usernameInput));
    if (!user) {
      return null;
    }
    const rating = user.rating ?? DEFAULT_RATING;
    const ratingGames = user.ratingGames ?? 0;
    return {
      username: user.username,
      rating: toDisplayRating(rating, ratingGames),
      ratingGames,
      provisional: isProvisionalRating(rating, ratingGames),
      createdAt: user.createdAt,
      isAdmin: user.isAdmin === true,
      ratingHistory: Array.isArray(user.ratingHistory) ? [...user.ratingHistory] : [],
    };
  }

  listTopRated(limit: number): TopRatedEntry[] {
    const capped = Math.max(1, Math.min(100, Math.floor(limit) || 10));
    const entries: TopRatedEntry[] = [];
    for (const user of this.usersByKey.values()) {
      const ratingGames = user.ratingGames ?? 0;
      if (ratingGames <= 0) {
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

  private async migrateFirstAdmin(): Promise<boolean> {
    if (this.usersByKey.size === 0) {
      return false;
    }
    for (const user of this.usersByKey.values()) {
      if (user.isAdmin === true) {
        return false;
      }
    }
    const first = this.usersByKey.values().next().value;
    if (!first) {
      return false;
    }
    first.isAdmin = true;
    await this.persist();
    return true;
  }

  private normalize(username: string): string {
    return username.trim().toLowerCase();
  }

  private replaceUsers(users: StoredUser[]): void {
    this.usersByKey = new Map(users.map((user) => [this.normalize(user.username), { ...user }]));
  }

  private async loadFromBinary(): Promise<StoredUser[]> {
    const raw = await readFile(this.binaryFilePath);
    const parsed = await decodeUserFileBinary(raw);
    return parseUserFile(parsed);
  }

  private hashPassword(password: string, salt: string): string {
    return scryptSync(password, salt, 64).toString('hex');
  }

  private persist(): Promise<void> {
    const data: UserFile = {
      users: [...this.usersByKey.values()],
    };
    // serialize 同步执行，调用时即拿到状态快照；压缩与写盘排队串行执行。
    const binaryPromise = encodeUserFileBinary(data);
    const task = this.writeQueue.then(async () => {
      const binary = await binaryPromise;
      const tmpPath = `${this.binaryFilePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmpPath, binary);
      await rename(tmpPath, this.binaryFilePath);
    });
    this.writeQueue = task.catch(() => undefined);
    return task;
  }
}
