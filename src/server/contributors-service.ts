const GITHUB_CONTRIBUTORS_URL =
  'https://api.github.com/repos/oimasterkafuu/Roka/contributors?per_page=100&anon=1';
const CONTRIBUTORS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CONTRIBUTORS_FETCH_TIMEOUT_MS = 10_000;

interface Contributor {
  login: string;
  html_url: string;
  avatar_url: string;
  contributions: number;
}

interface ContributorsServiceOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

function isValidLogin(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 39 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value) &&
    !value.includes('--')
  );
}

function parseGithubUrl(value: unknown, hostname: string): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== hostname ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function parseContributor(value: unknown): Contributor | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (item.type === 'Bot' || !isValidLogin(item.login)) return null;
  if (!Number.isSafeInteger(item.contributions) || (item.contributions as number) < 1) return null;

  const profileUrl = parseGithubUrl(item.html_url, 'github.com');
  if (!profileUrl || profileUrl.pathname !== `/${item.login}` || profileUrl.search) return null;
  const avatarUrl = parseGithubUrl(item.avatar_url, 'avatars.githubusercontent.com');
  if (!avatarUrl || avatarUrl.pathname === '/') return null;

  return {
    login: item.login,
    html_url: `https://github.com/${item.login}`,
    avatar_url: avatarUrl.toString(),
    contributions: item.contributions as number,
  };
}

class ContributorsService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cache: Contributor[] | null = null;
  private cachedAt = 0;
  private pending: Promise<Contributor[]> | null = null;

  constructor(options: ContributorsServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? CONTRIBUTORS_FETCH_TIMEOUT_MS;
  }

  async getContributors(): Promise<Contributor[]> {
    if (this.cache !== null && this.now() - this.cachedAt < CONTRIBUTORS_CACHE_TTL_MS) {
      return this.cache;
    }
    if (!this.pending) {
      this.pending = this.fetchContributors()
        .then((contributors) => {
          this.cache = contributors;
          this.cachedAt = this.now();
          return contributors;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    const request = this.pending;
    try {
      return await request;
    } catch (error) {
      if (this.cache !== null) return this.cache;
      throw error;
    }
  }

  private async fetchContributors(): Promise<Contributor[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(GITHUB_CONTRIBUTORS_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Roka-Contributors',
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`GitHub contributors request failed: ${response.status}`);
      const body: unknown = await response.json();
      if (!Array.isArray(body)) throw new Error('GitHub contributors response is not an array');
      return body
        .map(parseContributor)
        .filter((item): item is Contributor => item !== null)
        .sort((a, b) => b.contributions - a.contributions || a.login.localeCompare(b.login));
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface ContributorReply {
  code(statusCode: number): ContributorReply;
  send(payload: unknown): unknown;
}

async function handleContributorsRequest(service: ContributorsService, reply: ContributorReply) {
  try {
    return reply.send(await service.getContributors());
  } catch {
    return reply.code(503).send({ error: '暂时无法从 GitHub 获取贡献者名单，请稍后重试。' });
  }
}

export { CONTRIBUTORS_CACHE_TTL_MS, GITHUB_CONTRIBUTORS_URL, ContributorsService, handleContributorsRequest };
export type { Contributor };
