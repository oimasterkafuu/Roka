import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { GithubPublicProfile, UserStore } from '../auth-store';
import { StargazerLookup } from './stargazer-service';

const GITHUB_STATE_TTL_MS = 10 * 60 * 1000;
export const GITHUB_STAR_CACHE_TTL_MS = 15 * 60 * 1000;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;

interface GithubActor {
  username: string;
  sid?: string;
}

interface OAuthState {
  username: string;
  sid: string;
  verifier: string;
  expiresAt: number;
  generation: number;
  controller: AbortController;
}

interface GithubServiceOptions {
  userStore: UserStore;
  stargazerService: StargazerLookup;
  jwtSecret: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  oauthBaseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

type GithubErrorCode =
  'not-configured' | 'state' | 'denied' | 'exchange' | 'identity' | 'conflict' | 'star' | 'unlinked';

export class GithubServiceError extends Error {
  constructor(readonly code: GithubErrorCode) {
    super(code);
    this.name = 'GithubServiceError';
  }
}

class GithubHttpError extends Error {
  constructor(readonly status: number) {
    super(`GitHub HTTP ${status}`);
  }
}

export class GithubService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly tokenKey: Buffer;
  private readonly oauthBaseUrl: string;
  private readonly apiBaseUrl: string;
  private nextGeneration = 0;
  private readonly operations = new Map<string, OAuthState>();
  private readonly states = new Map<string, OAuthState>();
  private readonly stateByUser = new Map<string, string>();
  private readonly starRefreshes = new Map<string, Promise<GithubPublicProfile | null>>();

  constructor(private readonly options: GithubServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
    this.tokenKey = createHmac('sha256', options.jwtSecret).update('roka:github-token:v1').digest();
    this.oauthBaseUrl = (options.oauthBaseUrl || 'https://github.com').replace(/\/+$/, '');
    this.apiBaseUrl = (options.apiBaseUrl || 'https://api.github.com').replace(/\/+$/, '');
  }

  isConfigured(): boolean {
    return Boolean(this.options.clientId && this.options.clientSecret && this.options.redirectUri);
  }

  startLink(actor: GithubActor): string {
    if (!this.isConfigured()) throw new GithubServiceError('not-configured');
    if (!actor.sid || !this.options.userStore.isSessionValid(actor.username, actor.sid)) {
      throw new GithubServiceError('state');
    }
    this.pruneStates();

    this.cancelLink(actor.username);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const operation: OAuthState = {
      username: actor.username,
      sid: actor.sid,
      verifier,
      expiresAt: this.now() + GITHUB_STATE_TTL_MS,
      generation: ++this.nextGeneration,
      controller: new AbortController(),
    };
    this.states.set(state, operation);
    this.operations.set(actor.username, operation);
    this.stateByUser.set(actor.username, state);

    const url = new URL(`${this.oauthBaseUrl}/login/oauth/authorize`);
    url.searchParams.set('client_id', this.options.clientId as string);
    url.searchParams.set('redirect_uri', this.options.redirectUri as string);
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async completeLink(
    actor: GithubActor,
    query: { code?: unknown; state?: unknown; error?: unknown },
  ): Promise<GithubPublicProfile> {
    if (!this.isConfigured()) throw new GithubServiceError('not-configured');
    const stateKey = typeof query.state === 'string' ? query.state : '';
    const state = this.states.get(stateKey);
    if (state) {
      this.states.delete(stateKey);
      if (this.stateByUser.get(state.username) === stateKey) {
        this.stateByUser.delete(state.username);
      }
    }
    if (
      !state ||
      state.expiresAt < this.now() ||
      state.username !== actor.username ||
      !actor.sid ||
      state.sid !== actor.sid
    ) {
      if (state && this.operations.get(state.username) === state) this.cancelLink(state.username);
      throw new GithubServiceError('state');
    }

    try {
      if (query.error !== undefined) throw new GithubServiceError('denied');
      if (typeof query.code !== 'string' || !query.code || query.code.length > 512) {
        throw new GithubServiceError('exchange');
      }
      this.assertCurrentOperation(state);
      const accessToken = await this.exchangeCode(query.code, state.verifier, state.controller.signal);
      const identity = await this.fetchIdentity(accessToken, state.controller.signal);
      const starred = this.options.stargazerService.isStarred(identity.login);

      this.assertCurrentOperation(state);
      try {
        await this.options.userStore.linkGithub(actor.username, {
          id: identity.id,
          login: identity.login,
          linkedAt: this.now(),
          accessTokenEncrypted: this.encryptToken(accessToken),
          ...(starred === null ? {} : { starred, starVerifiedAt: this.now() }),
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes('已绑定其他')) {
          throw new GithubServiceError('conflict');
        }
        throw error;
      }
      const profile = this.options.userStore.getGithubPublicProfile(actor.username, this.now());
      if (!profile) throw new GithubServiceError('identity');
      return profile;
    } catch (error) {
      this.assertCurrentOperation(state);
      throw error;
    } finally {
      if (this.operations.get(state.username)?.generation === state.generation) {
        this.operations.delete(state.username);
      }
    }
  }

  private assertCurrentOperation(state: OAuthState): void {
    if (
      state.controller.signal.aborted ||
      this.operations.get(state.username)?.generation !== state.generation ||
      !this.options.userStore.isSessionValid(state.username, state.sid)
    ) {
      throw new GithubServiceError('state');
    }
  }

  private cancelLink(username: string): void {
    const stateKey = this.stateByUser.get(username);
    if (stateKey) this.states.delete(stateKey);
    this.stateByUser.delete(username);
    this.operations.get(username)?.controller.abort();
    this.operations.delete(username);
  }

  async unlink(username: string): Promise<boolean> {
    this.cancelLink(username);
    return this.options.userStore.unlinkGithub(username);
  }

  async refreshStar(username: string, force = false): Promise<GithubPublicProfile | null> {
    const credential = this.options.userStore.getGithubCredential(username);
    if (!credential) return null;
    const verifiedAt = credential.starVerifiedAt;
    if (
      !force &&
      typeof verifiedAt === 'number' &&
      verifiedAt <= this.now() &&
      this.now() - verifiedAt < GITHUB_STAR_CACHE_TTL_MS
    ) {
      return this.options.userStore.getGithubPublicProfile(username, this.now());
    }
    const pending = this.starRefreshes.get(username);
    if (pending) return pending;

    const refresh = this.performStarRefresh(username, credential.id).finally(() => {
      this.starRefreshes.delete(username);
    });
    this.starRefreshes.set(username, refresh);
    return refresh;
  }

  private async performStarRefresh(
    username: string,
    expectedId: number,
  ): Promise<GithubPublicProfile | null> {
    const credential = this.options.userStore.getGithubCredential(username);
    if (!credential || credential.id !== expectedId) {
      return this.options.userStore.getGithubPublicProfile(username, this.now());
    }
    const starred = this.options.stargazerService.isStarred(credential.login);
    await this.options.userStore.updateGithubStar(username, expectedId, starred, this.now());
    return this.options.userStore.getGithubPublicProfile(username, this.now());
  }

  private async exchangeCode(code: string, verifier: string, signal: AbortSignal): Promise<string> {
    try {
      return await this.request(
        `${this.oauthBaseUrl}/login/oauth/access_token`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Roka-GitHub-Link',
          },
          body: new URLSearchParams({
            client_id: this.options.clientId as string,
            client_secret: this.options.clientSecret as string,
            code,
            redirect_uri: this.options.redirectUri as string,
            code_verifier: verifier,
          }).toString(),
        },
        async (response) => {
          if (!response.ok) throw new GithubHttpError(response.status);
          const body: unknown = await response.json();
          if (!body || typeof body !== 'object') throw new Error('invalid token response');
          const token = (body as Record<string, unknown>).access_token;
          if (typeof token !== 'string' || !token || token.length > 4096) {
            throw new Error('invalid access token');
          }
          return token;
        },
        signal,
      );
    } catch {
      throw new GithubServiceError('exchange');
    }
  }

  private async fetchIdentity(
    accessToken: string,
    signal: AbortSignal,
  ): Promise<{ id: number; login: string }> {
    try {
      return await this.request(
        `${this.apiBaseUrl}/user`,
        {
          headers: this.apiHeaders(accessToken),
        },
        async (response) => {
          if (!response.ok) throw new GithubHttpError(response.status);
          const body: unknown = await response.json();
          if (!body || typeof body !== 'object') throw new Error('invalid identity response');
          const { id, login, type } = body as Record<string, unknown>;
          if (
            !Number.isSafeInteger(id) ||
            (id as number) <= 0 ||
            typeof login !== 'string' ||
            login.length > 39 ||
            !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(login) ||
            login.includes('--') ||
            type !== 'User'
          ) {
            throw new Error('invalid GitHub identity');
          }
          return { id: id as number, login };
        },
        signal,
      );
    } catch {
      throw new GithubServiceError('identity');
    }
  }

  private apiHeaders(accessToken: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Roka-GitHub-Link',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    operationSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = operationSignal
      ? AbortSignal.any([controller.signal, operationSignal])
      : controller.signal;
    let response: Response | undefined;
    try {
      response = await this.fetchImpl(url, { ...init, redirect: 'error', signal });
      return await consume(response);
    } finally {
      clearTimeout(timeout);
      // Also release unread error bodies when validation/HTTP status rejects early.
      if (response?.body && !response.body.locked) await response.body.cancel();
    }
  }

  private encryptToken(token: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.tokenKey, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(
      '.',
    );
  }

  private pruneStates(): void {
    for (const [key, state] of this.states) {
      if (state.expiresAt < this.now()) {
        this.states.delete(key);
        if (this.stateByUser.get(state.username) === key) this.cancelLink(state.username);
      }
    }
  }
}
