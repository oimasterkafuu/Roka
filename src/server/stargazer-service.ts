import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STARGAZERS_PATH = '/repos/oimasterkafuu/Roka/stargazers?per_page=100';
const STARGAZER_REQUEST_TIMEOUT_MS = 10_000;
export const STARGAZER_RETRY_INTERVAL_MS = 5 * 60 * 1000;
export const STARGAZER_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
  token?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  retryIntervalMs?: number;
  syncIntervalMs?: number;
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
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly retryIntervalMs: number;
  private readonly syncIntervalMs: number;
  private readonly apiBaseUrl: string;
  private readonly logger: StargazerLogger;
  private fetchedAt: number | null = null;
  private stars = new Map<string, StargazerRecord>();
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<boolean> | null = null;
  private activeController: AbortController | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;
  private lastError: string | null = null;

  constructor(private readonly options: StargazerServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? STARGAZER_REQUEST_TIMEOUT_MS;
    this.retryIntervalMs = options.retryIntervalMs ?? STARGAZER_RETRY_INTERVAL_MS;
    this.syncIntervalMs = options.syncIntervalMs ?? STARGAZER_SYNC_INTERVAL_MS;
    this.apiBaseUrl = (options.apiBaseUrl || 'https://api.github.com').replace(/\/+$/, '');
    this.logger = options.logger ?? console;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.load();
    this.started = true;
    this.stopped = false;
    if (!this.options.token?.trim()) {
      this.logger.warn(
        'GITHUB_STARGAZERS_TOKEN is not configured; anonymous stargazer requests have a low rate limit.',
      );
    }
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.activeController?.abort();
  }

  isStarred(login: string): boolean | null {
    if (this.fetchedAt === null) return null;
    return this.stars.has(login.trim().toLowerCase());
  }

  listStargazers(): Array<{ login: string; avatarUrl: string }> {
    if (this.fetchedAt === null) return [];
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

  getLastError(): string | null {
    return this.lastError;
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
    return true;
  }

  refresh(): Promise<boolean> {
    if (this.pending) return this.pending;
    const pending = this.performRefresh().finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  private async performRefresh(): Promise<boolean> {
    let succeeded = false;
    try {
      const stars = await this.fetchAll();
      const fetchedAt = this.now();
      await this.persist({ fetchedAt, stars: Object.fromEntries(stars) });
      this.stars = stars;
      this.fetchedAt = fetchedAt;
      this.lastError = null;
      succeeded = true;
      this.logger.info(`Loaded ${stars.size} GitHub stargazers.`);
      return true;
    } catch (error) {
      if (!this.stopped) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.logger.error('Failed to refresh GitHub stargazers; keeping the previous table.', error);
      }
      return false;
    } finally {
      if (this.started && !this.stopped) {
        this.schedule(succeeded ? this.syncIntervalMs : this.retryIntervalMs);
      }
      this.activeController = null;
    }
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delay);
    this.timer.unref();
  }

  private async fetchAll(): Promise<Map<string, StargazerRecord>> {
    const stars = new Map<string, StargazerRecord>();
    const visited = new Set<string>();
    let nextUrl: string | null = `${this.apiBaseUrl}${STARGAZERS_PATH}`;
    const controller = new AbortController();
    this.activeController = controller;

    while (nextUrl) {
      if (visited.has(nextUrl)) throw new Error('GitHub stargazers pagination did not terminate');
      visited.add(nextUrl);
      const { records, next } = await this.fetchPage(nextUrl, controller.signal);
      for (const record of records) stars.set(record.login.toLowerCase(), record);
      nextUrl = next;
    }
    return stars;
  }

  private async fetchPage(
    url: string,
    operationSignal: AbortSignal,
  ): Promise<{ records: StargazerRecord[]; next: string | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();
    const signal = AbortSignal.any([controller.signal, operationSignal]);
    let response: Response | undefined;
    try {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Roka-Stargazers',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      const token = this.options.token?.trim();
      if (token) headers.Authorization = `Bearer ${token}`;
      response = await this.fetchImpl(url, { method: 'GET', headers, redirect: 'error', signal });
      if (!response.ok) throw new Error(`GitHub stargazers request failed: ${response.status}`);
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error('GitHub stargazers response is not an array');
      return {
        records: body.map(parseStargazer).filter((item): item is StargazerRecord => item !== null),
        next: this.parseNextLink(response.headers.get('link')),
      };
    } finally {
      clearTimeout(timeout);
      if (response?.body && !response.body.locked) await response.body.cancel();
    }
  }

  private parseNextLink(header: string | null): string | null {
    if (!header) return null;
    for (const part of header.split(',')) {
      const match = part.match(/^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/i);
      if (match) return match[1];
    }
    return null;
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.error('Failed to load the saved GitHub stargazer table.', error);
      }
      this.fetchedAt = null;
      this.stars = new Map();
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
