import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface StargazerRecord {
  login: string;
  avatarUrl: string;
  starredAt?: string;
}

interface StargazerFile {
  fetchedAt: number | null;
  stars: Record<string, StargazerRecord>;
}

interface StargazerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

interface StargazerServiceOptions {
  filePath: string;
  now?: () => number;
  logger?: StargazerLogger;
}

interface StargazerLookup {
  isStarred(login: string): boolean | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isValidLogin = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 39 &&
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value) &&
  !value.includes('--');

const parseAvatarUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      (url.hostname !== 'avatars.githubusercontent.com' && url.hostname !== 'github.com') ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.pathname === '/'
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

const parseStarredAt = (value: unknown): string | undefined =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;

const parseStargazer = (value: unknown): StargazerRecord | null => {
  if (!isRecord(value)) return null;
  const user = isRecord(value.user) ? value.user : value;
  if (!isValidLogin(user.login)) return null;
  const avatarUrl = parseAvatarUrl(user.avatar_url ?? user.avatarUrl);
  if (!avatarUrl) return null;
  return {
    login: user.login,
    avatarUrl,
    starredAt: parseStarredAt(value.starred_at ?? value.starredAt),
  };
};

export class StargazerService implements StargazerLookup {
  private readonly now: () => number;
  private readonly logger: StargazerLogger;
  private fetchedAt: number | null = null;
  private stars = new Map<string, StargazerRecord>();
  private hasLocalTable = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(private readonly options: StargazerServiceOptions) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.load();
    this.started = true;
  }

  stop(): void {
    this.started = false;
  }

  isStarred(login: string): boolean | null {
    if (!this.hasLocalTable) return null;
    return this.stars.has(login.trim().toLowerCase());
  }

  listStargazers(): Array<{ login: string; avatarUrl: string }> {
    return [...this.stars.values()]
      .sort((a, b) => {
        const aTime = a.starredAt ? Date.parse(a.starredAt) : 0;
        const bTime = b.starredAt ? Date.parse(b.starredAt) : 0;
        return bTime - aTime || a.login.localeCompare(b.login);
      })
      .map(({ login, avatarUrl }) => ({ login, avatarUrl }));
  }

  getFetchedAt(): number | null {
    return this.fetchedAt;
  }

  async handleStarEvent(action: 'created' | 'deleted', login: string, avatarUrl?: string): Promise<boolean> {
    if (!isValidLogin(login)) return false;
    const key = login.toLowerCase();
    if (action === 'deleted') {
      this.stars.delete(key);
    } else {
      const previous = this.stars.get(key);
      this.stars.set(key, {
        login,
        avatarUrl:
          parseAvatarUrl(avatarUrl) ??
          previous?.avatarUrl ??
          `https://github.com/${encodeURIComponent(login)}.png`,
        starredAt: new Date(this.now()).toISOString(),
      });
    }
    await this.persist({ fetchedAt: this.fetchedAt, stars: Object.fromEntries(this.stars) });
    this.hasLocalTable = true;
    return true;
  }

  private async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.filePath, 'utf8'));
      if (!isRecord(parsed) || !isRecord(parsed.stars) || Array.isArray(parsed.stars)) {
        throw new Error('Invalid stargazer file');
      }
      if (
        parsed.fetchedAt !== null &&
        (typeof parsed.fetchedAt !== 'number' || !Number.isFinite(parsed.fetchedAt) || parsed.fetchedAt <= 0)
      ) {
        throw new Error('Invalid stargazer fetch timestamp');
      }
      const stars = new Map<string, StargazerRecord>();
      for (const value of Object.values(parsed.stars)) {
        const record = parseStargazer(value);
        if (record) stars.set(record.login.toLowerCase(), record);
      }
      this.fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : null;
      this.stars = stars;
      this.hasLocalTable = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.error('Failed to load the saved GitHub stargazer table.', error);
      }
      this.fetchedAt = null;
      this.stars = new Map();
      this.hasLocalTable = false;
    }
  }

  private persist(state: StargazerFile): Promise<void> {
    const serialized = JSON.stringify(state);
    const write = async (): Promise<void> => {
      await mkdir(path.dirname(this.options.filePath), { recursive: true });
      const temporary = `${this.options.filePath}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.options.filePath);
    };
    const result = this.writeQueue.then(write, write);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }
}

export type { StargazerLookup, StargazerRecord, StargazerServiceOptions };
