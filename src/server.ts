import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { isIP } from 'node:net';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import { Server as SocketIOServer } from 'socket.io';
import { AnnouncementStore, ANNOUNCEMENT_TEXT_MAX } from './announcement-store';
import { UserStore } from './auth-store';
import { FeedCooldownException, FeedStore } from './feed-store';
import { GameEngine } from './game-engine';
import { resolveMapSizeRatioByPlayers } from './map/map-size';
import { ratingTier } from './rating-color';
import { encodeReplayPatchBinary } from './replay-patch-binary';
import { isReplayIdValid, ReplayStore } from './replay-store';
import { ensureRuntimeEnv } from './runtime-env';
import { renderRichText } from './text-render';
import { FeedPost, LobbyConfig, MAX_TEAMS, MoveMode } from './types';
import { AuthRequest, AuthService } from './server/auth-service';
import { CaptchaService } from './server/captcha-service';
import { EditableLobbyKey, LobbyService } from './server/lobby-service';
import { WebhookUpdater } from './server/webhook-updater';

const runtimeEnv = ensureRuntimeEnv();
const app = Fastify({ logger: true });

// 回放上传：接收原始 .rpl 文件（ops-v1 操作流，通常仅几百字节）。
app.addContentTypeParser(
  'application/octet-stream',
  { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
  (_request, payload, done) => {
    done(null, payload);
  },
);

const dataDir = process.env.ROKA_DATA_DIR
  ? path.resolve(process.env.ROKA_DATA_DIR)
  : path.join(process.cwd(), 'data');
const replayStore = new ReplayStore(path.join(dataDir, 'replays'), {
  buildReplayFromActions: GameEngine.buildReplayFromActions,
});
const userStore = new UserStore(dataDir);
const feedStore = new FeedStore(dataDir);
const announcementStore = new AnnouncementStore(dataDir);
const authService = new AuthService(userStore);
const captchaService = new CaptchaService();
const lobbyService = new LobbyService(replayStore, userStore);
const webhookUpdater = new WebhookUpdater(app.log, runtimeEnv.webhookSecret, () =>
  lobbyService.hasActiveGames(),
);
lobbyService.onGameEnded = () => webhookUpdater.notifyGameEnded();

type PushWebhookPayload = { ref?: unknown };
const GENERAL_RATE_LIMIT = { max: 1000, timeWindow: '1 minute' };
const WEBHOOK_RATE_LIMIT = { max: 20, timeWindow: '1 minute' };
const AUTH_PAGE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' };
const AUTH_ACTION_RATE_LIMIT = { max: 20, timeWindow: '1 minute' };
const MAP_EXAMPLE_DEFAULT_PLAYER_COUNT = 4;
const MAP_EXAMPLE_MIN_PLAYER_COUNT = 2;
const MAP_EXAMPLE_MAX_PLAYER_COUNT = MAX_TEAMS;
const MAP_EXAMPLE_MAP_MODES: LobbyConfig['map_mode'][] = ['random', 'maze', 'archipelago', 'mediterranean'];
const RATE_LIMIT_REAL_IP_HEADERS = [
  'cf-connecting-ip',
  'true-client-ip',
  'x-real-ip',
  'x-forwarded-for',
  'x-client-ip',
  'forwarded',
] as const;
const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/;

/**
 * Bot 令牌表：ROKA_BOT_TOKENS 格式 "token1:username1,token2:username2"。
 * 仅用于 socket.io 握手认证，合成用户不要求存在于 userStore。
 */
const botTokens = new Map<string, string>();
for (const entry of String(process.env.ROKA_BOT_TOKENS ?? '').split(',')) {
  const trimmed = entry.trim();
  if (!trimmed) {
    continue;
  }
  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex <= 0) {
    continue;
  }
  const token = trimmed.slice(0, separatorIndex).trim();
  const username = trimmed.slice(separatorIndex + 1).trim();
  if (token && USERNAME_REGEX.test(username)) {
    botTokens.set(token, username);
  }
}

const buildMapExample = async (
  mapMode: LobbyConfig['map_mode'],
  playerCount: number,
): Promise<{
  map_mode: LobbyConfig['map_mode'];
  n: number;
  m: number;
  grid_type: number[];
  army_cnt: number[];
}> => {
  const mapToken = randomBytes(16).toString('hex');
  const mapSizeRatio = resolveMapSizeRatioByPlayers(playerCount);
  const playerNames = Array.from({ length: playerCount }, (_, index) => `P${index + 1}`);
  const playerTeams = Array.from({ length: playerCount }, (_, index) => index + 1);
  const generated = await GameEngine.buildReplayBaseMap({
    width_ratio: mapSizeRatio,
    height_ratio: mapSizeRatio,
    city_ratio: 0.5,
    mountain_ratio: 0.5,
    swamp_ratio: 0,
    speed: 1,
    allow_team: false,
    map_token: mapToken,
    map_mode: mapMode,
    player_names: playerNames,
    player_teams: playerTeams,
    map_size_version: 2,
  });
  return {
    map_mode: mapMode,
    ...generated,
  };
};

const isMapExampleMode = (value: string): value is LobbyConfig['map_mode'] =>
  MAP_EXAMPLE_MAP_MODES.includes(value as LobbyConfig['map_mode']);

interface DecoratedFeedComment {
  id: string;
  author: string;
  text: string;
  time: number;
  html: string;
}

interface DecoratedFeedPost {
  id: string;
  author: string;
  text: string;
  time: number;
  likes: string[];
  comments: DecoratedFeedComment[];
  html: string;
  authorInfo: { colorClass: string; title: string };
  canManage: boolean;
}

const decorateFeedPost = (post: FeedPost, viewer: string | null): DecoratedFeedPost => {
  const { rating, ratingGames } = userStore.getDisplayRating(post.author);
  const tier = ratingTier(rating, ratingGames);
  return {
    ...post,
    comments: post.comments.map((comment) => ({ ...comment, html: renderRichText(comment.text) })),
    html: renderRichText(post.text),
    authorInfo: { colorClass: tier.className, title: tier.title },
    canManage: viewer !== null && (viewer === post.author || userStore.isAdminUser(viewer)),
  };
};

const parseMapExamplePlayerCount = (value: unknown): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return MAP_EXAMPLE_DEFAULT_PLAYER_COUNT;
  }
  return Math.max(MAP_EXAMPLE_MIN_PLAYER_COUNT, Math.min(MAP_EXAMPLE_MAX_PLAYER_COUNT, parsed));
};

const normalizeIpToken = (token: string): string | null => {
  const trimmed = token.trim().replace(/^"(.+)"$/u, '$1');
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return null;
  }

  const strippedForPrefix = trimmed
    .replace(/^for=/iu, '')
    .trim()
    .replace(/^"(.+)"$/u, '$1');
  const bracketWrapped = strippedForPrefix.match(/^\[([^[\]]+)\](?::\d+)?$/u);
  const maybeIp = bracketWrapped ? bracketWrapped[1] : strippedForPrefix;
  const normalized = maybeIp.startsWith('::ffff:') ? maybeIp.slice(7) : maybeIp;

  if (isIP(normalized)) {
    return normalized;
  }

  const ipv4WithPort = normalized.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/u);
  if (ipv4WithPort && isIP(ipv4WithPort[1])) {
    return ipv4WithPort[1];
  }

  return null;
};

const isPrivateOrLoopbackIp = (ip: string): boolean => {
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }

  const lowered = ip.toLowerCase();
  return (
    lowered === '::1' ||
    lowered === '::' ||
    lowered.startsWith('fc') ||
    lowered.startsWith('fd') ||
    lowered.startsWith('fe8') ||
    lowered.startsWith('fe9') ||
    lowered.startsWith('fea') ||
    lowered.startsWith('feb')
  );
};

const extractHeaderIpCandidates = (value: unknown): string[] => {
  const rawValues: string[] = [];
  if (typeof value === 'string') {
    rawValues.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        rawValues.push(item);
      }
    }
  }

  const candidates: string[] = [];
  for (const rawValue of rawValues) {
    for (const entry of rawValue.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) {
        continue;
      }

      const lowered = trimmed.toLowerCase();
      if (lowered.includes('for=')) {
        const segments = trimmed.split(';');
        const forSegment = segments.find((segment) => segment.trim().toLowerCase().startsWith('for='));
        if (forSegment) {
          candidates.push(forSegment.trim());
          continue;
        }
      }
      candidates.push(trimmed);
    }
  }
  return candidates;
};

const getRealIpFromHeaders = (request: FastifyRequest): string | null => {
  const headers = request.headers as Record<string, unknown>;

  for (const header of RATE_LIMIT_REAL_IP_HEADERS) {
    const candidates = extractHeaderIpCandidates(headers[header]);
    for (const candidate of candidates) {
      const normalized = normalizeIpToken(candidate);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
};

const getRemoteIp = (request: FastifyRequest): string | null => {
  const remoteAddress = request.socket.remoteAddress;
  if (typeof remoteAddress === 'string') {
    const normalized = normalizeIpToken(remoteAddress);
    if (normalized) {
      return normalized;
    }
  }

  return typeof request.ip === 'string' ? normalizeIpToken(request.ip) : null;
};

const resolveRateLimitKey = (request: FastifyRequest): string => {
  const remoteIp = getRemoteIp(request);
  if (remoteIp && isPrivateOrLoopbackIp(remoteIp)) {
    const realIp = getRealIpFromHeaders(request);
    if (realIp) {
      return realIp;
    }
  }
  return remoteIp ?? 'unknown';
};

const parseJsonObject = (text: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
};

const readHeaderValue = (headers: Record<string, unknown>, key: string): string | null => {
  const value = headers[key];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return null;
};

const parsePushWebhookPayload = (
  body: unknown,
  rawBody: Buffer,
  headers: Record<string, unknown>,
): PushWebhookPayload | null => {
  const rawText = rawBody.toString('utf8');
  const directJson = parseJsonObject(rawText);
  if (directJson) {
    return directJson;
  }

  const contentType = readHeaderValue(headers, 'content-type') ?? '';
  const mightBeFormBody =
    contentType.includes('application/x-www-form-urlencoded') || rawText.includes('payload=');
  if (mightBeFormBody) {
    const encodedPayload = new URLSearchParams(rawText).get('payload');
    if (encodedPayload) {
      const parsedPayload = parseJsonObject(encodedPayload);
      if (parsedPayload) {
        return parsedPayload;
      }
    }
  }

  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    const bodyObject = body as Record<string, unknown>;
    if (typeof bodyObject.payload === 'string') {
      const payloadInBody = parseJsonObject(bodyObject.payload);
      if (payloadInBody) {
        return payloadInBody;
      }
    }
    if ('ref' in bodyObject) {
      return bodyObject;
    }
  }

  return null;
};

if (runtimeEnv.createdKeys.length > 0) {
  app.log.info({ keys: runtimeEnv.createdKeys }, '已自动补全缺失环境变量到 .env。');
}

const boot = async (): Promise<void> => {
  await replayStore.ensureReady();
  await userStore.ensureReady();
  await feedStore.ensureReady();
  await announcementStore.ensureReady();

  await app.register(fastifyRateLimit, {
    max: GENERAL_RATE_LIMIT.max,
    timeWindow: GENERAL_RATE_LIMIT.timeWindow,
    keyGenerator: resolveRateLimitKey,
  });
  app.addHook('onRequest', app.rateLimit(GENERAL_RATE_LIMIT));

  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0];
    if (authService.isPublicPath(pathname)) {
      return;
    }

    const token = authService.getTokenFromCookie(request.headers.cookie);
    const authUser = authService.verifyAuthToken(token);
    if (!authUser) {
      if (pathname.startsWith('/api/')) {
        return reply.code(401).send({ error: '未登录或登录已失效。' });
      }
      return reply.redirect('/login');
    }

    (request as AuthRequest).authUser = authUser;
  });

  await app.register(fastifyStatic, {
    root: path.join(process.cwd(), 'static'),
    prefix: '/',
  });

  await app.register(async (webhookApp) => {
    const webhookRateLimitPreHandler = webhookApp.rateLimit(WEBHOOK_RATE_LIMIT);

    webhookApp.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, payload, done) => {
      done(null, payload);
    });

    const postReceiveHandler = async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body;
      const rawBody = Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : body ? JSON.stringify(body) : '');
      const headers = request.headers as Record<string, unknown>;

      if (!webhookUpdater.isAuthorized(rawBody, headers)) {
        return reply.code(401).send({ error: 'Webhook signature verification failed.' });
      }

      const eventHeader = request.headers['x-github-event'];
      const event =
        typeof eventHeader === 'string'
          ? eventHeader
          : Array.isArray(eventHeader) && typeof eventHeader[0] === 'string'
            ? eventHeader[0]
            : '';

      if (event === 'ping') {
        return reply.send({ ok: true, event: 'ping' });
      }

      if (event === 'push') {
        const payload = parsePushWebhookPayload(body, rawBody, headers);
        if (!payload) {
          return reply.code(400).send({ error: 'Invalid webhook payload.' });
        }

        if (payload?.ref !== 'refs/heads/main') {
          return reply.send({ ok: true, ignored: true, reason: 'non-main push' });
        }
      }

      const queued = webhookUpdater.requestUpdate();
      return reply.code(202).send({ ok: true, queued });
    };

    webhookApp.post('/postreceive', { preHandler: webhookRateLimitPreHandler }, postReceiveHandler);
    webhookApp.post('/postreceive/', { preHandler: webhookRateLimitPreHandler }, postReceiveHandler);
  });

  const authPageRateLimitPreHandler = app.rateLimit(AUTH_PAGE_RATE_LIMIT);
  const authActionRateLimitPreHandler = app.rateLimit(AUTH_ACTION_RATE_LIMIT);

  app.get('/login', { preHandler: authPageRateLimitPreHandler }, async (request, reply) => {
    const token = authService.getTokenFromCookie(request.headers.cookie);
    const authUser = authService.verifyAuthToken(token);
    if (authUser) {
      return reply.redirect('/');
    }
    return reply.sendFile('login.html');
  });

  app.get('/api/auth/captcha', { preHandler: authActionRateLimitPreHandler }, async (_request, reply) => {
    return reply.send(captchaService.createChallenge());
  });

  app.post('/api/auth/register', { preHandler: authActionRateLimitPreHandler }, async (request, reply) => {
    const body = request.body as {
      username?: string;
      password?: string;
      captchaId?: string;
      captchaCode?: string;
      website?: string;
    };
    const usernameRaw = String(body?.username ?? '');
    const password = String(body?.password ?? '');
    const captchaId = String(body?.captchaId ?? '');
    const captchaCode = String(body?.captchaCode ?? '');
    const honeypot = String(body?.website ?? '').trim();

    if (honeypot.length > 0) {
      return reply.code(400).send({ error: '请求无效。' });
    }

    const captchaCheck = captchaService.verifyAndConsume(captchaId, captchaCode);
    if (!captchaCheck.ok) {
      return reply.code(400).send({ error: captchaCheck.error ?? '验证码校验失败。' });
    }

    try {
      const username = await userStore.register(usernameRaw, password);
      const sessionId = await userStore.rotateSession(username);
      authService.disconnectUserSockets(username);
      const token = authService.signAuthToken(username, sessionId);
      authService.setAuthCookie(reply, token);
      return reply.send({ username });
    } catch (error) {
      const message = error instanceof Error ? error.message : '注册失败。';
      const status = message.includes('存在') ? 409 : 400;
      return reply.code(status).send({ error: message });
    }
  });

  app.post('/api/auth/login', { preHandler: authActionRateLimitPreHandler }, async (request, reply) => {
    const body = request.body as {
      username?: string;
      password?: string;
      captchaId?: string;
      captchaCode?: string;
      website?: string;
    };
    const usernameRaw = String(body?.username ?? '');
    const password = String(body?.password ?? '');
    const captchaId = String(body?.captchaId ?? '');
    const captchaCode = String(body?.captchaCode ?? '');
    const honeypot = String(body?.website ?? '').trim();

    if (honeypot.length > 0) {
      return reply.code(400).send({ error: '请求无效。' });
    }

    const captchaCheck = captchaService.verifyAndConsume(captchaId, captchaCode);
    if (!captchaCheck.ok) {
      return reply.code(400).send({ error: captchaCheck.error ?? '验证码校验失败。' });
    }

    const username = userStore.verifyPassword(usernameRaw, password);
    if (!username) {
      return reply.code(401).send({ error: '用户名或密码错误。' });
    }

    const sessionId = await userStore.rotateSession(username);
    authService.disconnectUserSockets(username);

    const token = authService.signAuthToken(username, sessionId);
    authService.setAuthCookie(reply, token);
    return reply.send({ username });
  });

  app.post('/api/auth/logout', { preHandler: authActionRateLimitPreHandler }, async (request, reply) => {
    const authUser = (request as AuthRequest).authUser;
    if (authUser) {
      await userStore.clearSession(authUser.username);
      authService.disconnectUserSockets(authUser.username);
    }
    authService.clearAuthCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (request, reply) => {
    const authUser = (request as AuthRequest).authUser;
    if (!authUser) {
      return reply.code(401).send({ error: '未登录或登录已失效。' });
    }
    return reply.send({
      username: authUser.username,
      rating: userStore.getDisplayRating(authUser.username),
      isAdmin: userStore.isAdminUser(authUser.username),
    });
  });

  const feedActionRateLimitPreHandler = app.rateLimit({ max: 60, timeWindow: '1 minute' });

  app.get('/api/feeds', async (request, reply) => {
    const authUser = (request as AuthRequest).authUser;
    if (!authUser) {
      return reply.code(401).send({ error: '未登录或登录已失效。' });
    }
    const query = request.query as { page?: unknown; limit?: unknown };
    const page = Number.parseInt(String(query.page ?? '1'), 10);
    const limit = Number.parseInt(String(query.limit ?? '10'), 10);
    const result = feedStore.listPage(page, limit);
    return reply.send({
      items: result.items.map((post) => decorateFeedPost(post, authUser.username)),
      total: result.total,
      page: result.page,
      pages: result.pages,
    });
  });

  app.post('/api/feeds', { preHandler: feedActionRateLimitPreHandler }, async (request, reply) => {
    const authUser = (request as AuthRequest).authUser;
    if (!authUser) {
      return reply.code(401).send({ error: '未登录或登录已失效。' });
    }
    const body = request.body as { text?: unknown };
    try {
      const post = await feedStore.create(authUser.username, String(body?.text ?? ''));
      io.emit('home_feeds');
      return reply.send({ post: decorateFeedPost(post, authUser.username) });
    } catch (error) {
      if (error instanceof FeedCooldownException) {
        return reply.code(429).send({ error: '发布太频繁，请 30 秒后再试', retryAfter: error.retryAfter });
      }
      return reply.code(400).send({ error: error instanceof Error ? error.message : '发布失败。' });
    }
  });

  app.post('/api/feeds/edit', { preHandler: feedActionRateLimitPreHandler }, async (request, reply) => {
    const authUser = (request as AuthRequest).authUser;
    if (!authUser) {
      return reply.code(401).send({ error: '未登录或登录已失效。' });
    }
    const body = request.body as { id?: unknown; text?: unknown };
    const post = feedStore.getById(String(body?.id ?? ''));
    if (!post) {
      return reply.code(404).send({ error: '动态不存在。' });
    }
    if (post.author !== authUser.username && !userStore.isAdminUser(authUser.username)) {
      return reply.code(403).send({ error: '没有权限编辑该动态。' });
    }
    try {
      const updated = await feedStore.update(post.id, String(body?.text ?? ''));
      io.emit('home_feeds');
      return reply.send({ post: decorateFeedPost(updated as FeedPost, authUser.username) });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '编辑失败。' });
    }
  });

  app.post('/api/feeds/delete', { preHandler: feedActionRateLimitPreHandler }, async (request, reply) => {
    const authUser = (request as AuthRequest).authUser;
    if (!authUser) {
      return reply.code(401).send({ error: '未登录或登录已失效。' });
    }
    const body = request.body as { id?: unknown };
    const post = feedStore.getById(String(body?.id ?? ''));
    if (!post) {
      return reply.code(404).send({ error: '动态不存在。' });
    }
    if (post.author !== authUser.username && !userStore.isAdminUser(authUser.username)) {
      return reply.code(403).send({ error: '没有权限删除该动态。' });
    }
    await feedStore.remove(post.id);
    io.emit('home_feeds');
    return reply.send({ ok: true });
  });

  app.post('/api/feeds/like', { preHandler: feedActionRateLimitPreHandler }, async (request, reply) => {
    const authUser = (request as AuthRequest).authUser;
    if (!authUser) {
      return reply.code(401).send({ error: '未登录或登录已失效。' });
    }
    const body = request.body as { id?: unknown };
    const result = await feedStore.toggleLike(String(body?.id ?? ''), authUser.username);
    if (!result) {
      return reply.code(404).send({ error: '动态不存在。' });
    }
    io.emit('home_feeds');
    return reply.send(result);
  });

  app.post('/api/feeds/comment', { preHandler: feedActionRateLimitPreHandler }, async (request, reply) => {
    const authUser = (request as AuthRequest).authUser;
    if (!authUser) {
      return reply.code(401).send({ error: '未登录或登录已失效。' });
    }
    const body = request.body as { id?: unknown; text?: unknown };
    try {
      const comment = await feedStore.addComment(
        String(body?.id ?? ''),
        authUser.username,
        String(body?.text ?? ''),
      );
      if (!comment) {
        return reply.code(404).send({ error: '动态不存在。' });
      }
      io.emit('home_feeds');
      return reply.send({ comment });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : '评论失败。' });
    }
  });

  app.get('/api/announcement', async (_request, reply) => {
    return reply.send(announcementStore.get());
  });

  app.post('/api/announcement', { preHandler: feedActionRateLimitPreHandler }, async (request, reply) => {
    const authUser = (request as AuthRequest).authUser;
    if (!authUser) {
      return reply.code(401).send({ error: '未登录或登录已失效。' });
    }
    if (!userStore.isAdminUser(authUser.username)) {
      return reply.code(403).send({ error: '仅管理员可以发布公告。' });
    }
    const body = request.body as { text?: unknown };
    try {
      const announcement = await announcementStore.set(String(body?.text ?? ''), authUser.username);
      io.emit('home_announcement');
      return reply.send(announcement);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : `公告内容不能超过 ${ANNOUNCEMENT_TEXT_MAX} 字。`,
      });
    }
  });

  app.get('/api/leaderboard', async (_request, reply) => {
    const items = userStore.listTopRated(10).map((entry) => {
      const tier = ratingTier(entry.rating, entry.ratingGames);
      return { ...entry, colorClass: tier.className, title: tier.title };
    });
    return reply.send({ items });
  });

  app.get('/api/profile/:username', async (request, reply) => {
    const { username } = request.params as { username: string };
    const profile = userStore.getPublicProfile(username);
    if (!profile) {
      return reply.code(404).send({ error: '用户不存在。' });
    }
    const tier = ratingTier(profile.rating, profile.ratingGames);
    return reply.send({
      ...profile,
      colorClass: tier.className,
      title: tier.title,
      registeredDays: Math.floor((Date.now() - profile.createdAt) / 86400000),
    });
  });

  app.get('/api/profile/:username/feeds', async (request, reply) => {
    const { username } = request.params as { username: string };
    const profile = userStore.getPublicProfile(username);
    if (!profile) {
      return reply.code(404).send({ error: '用户不存在。' });
    }
    const authUser = (request as AuthRequest).authUser;
    const query = request.query as { page?: unknown; limit?: unknown };
    const page = Number.parseInt(String(query.page ?? '1'), 10);
    const limit = Number.parseInt(String(query.limit ?? '10'), 10);
    const result = feedStore.listByAuthor(profile.username, page, limit);
    return reply.send({
      items: result.items.map((post) => decorateFeedPost(post, authUser?.username ?? null)),
      total: result.total,
      page: result.page,
      pages: result.pages,
    });
  });

  app.get('/api/profile/:username/replays', async (request, reply) => {
    const { username } = request.params as { username: string };
    const profile = userStore.getPublicProfile(username);
    if (!profile) {
      return reply.code(404).send({ error: '用户不存在。' });
    }

    const query = request.query as { offset?: unknown; limit?: unknown };
    const offsetRaw = Number.parseInt(String(query.offset ?? '0'), 10);
    const limitRaw = Number.parseInt(String(query.limit ?? '10'), 10);
    const offset = Number.isNaN(offsetRaw) || offsetRaw < 0 ? 0 : offsetRaw;
    const limit = Number.isNaN(limitRaw) || limitRaw <= 0 ? 10 : Math.min(limitRaw, 50);

    const allItems = await replayStore.listReplaysByPlayer(profile.username);
    const items = allItems.slice(offset, offset + limit);
    const next_offset = offset + items.length;
    const has_more = next_offset < allItems.length;

    return reply.send({ items, next_offset, has_more });
  });

  app.get('/games/:game_id', async (request, reply) => {
    const params = request.params as { game_id: string };
    const gameId = params.game_id;
    if (gameId.length === 0 || gameId.length > 15) {
      return reply.redirect(`/games/${lobbyService.randomRoomId()}`);
    }
    return reply.sendFile('game.html');
  });

  app.get('/', async (_request, reply) => reply.sendFile('index.html'));

  app.get('/rooms', async (_request, reply) => reply.redirect('/'));

  app.get('/replays', async (_request, reply) => reply.redirect('/'));

  app.get('/u/:username', async (request, reply) => {
    const { username } = request.params as { username: string };
    if (!USERNAME_REGEX.test(username)) {
      return reply.redirect('/');
    }
    return reply.sendFile('profile.html');
  });

  app.get('/develop', async (_request, reply) => reply.sendFile('develop.html'));
  app.get('/develop/bot', async (_request, reply) => reply.sendFile('develop-bot.html'));

  app.get('/about', async (_request, reply) => reply.sendFile('about.html'));
  app.get('/tutorial', async (_request, reply) => reply.sendFile('tutorial-text.html'));
  app.get('/tutorial/interactive', async (_request, reply) => reply.sendFile('tutorial.html'));

  app.get('/games', async (_request, reply) => {
    let html = '';
    let count = 0;
    for (const game of lobbyService.gameInstances.values()) {
      count += 1;
      html += `房间${count}：${game.names.join(' ')}<br>`;
    }
    return reply.type('text/html').send(html);
  });

  app.get('/replays/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isReplayIdValid(id)) {
      return reply.type('text/plain').send('');
    }
    return reply.sendFile('game.html');
  });

  app.get('/api/getreplay/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isReplayIdValid(id)) {
      return reply.code(404).send({ error: '回放不存在。' });
    }
    try {
      const replay = await replayStore.loadReplay(id);
      const binary = encodeReplayPatchBinary(replay);
      return reply.type('application/octet-stream').send(binary);
    } catch {
      // 加载/重建失败说明该回放已与当前版本不兼容，直接从库中删除。
      await replayStore.deleteReplay(id);
      return reply.code(404).send({ error: '回放不存在或已因不兼容被删除。' });
    }
  });

  // 下载回放：直接返回原始 .rpl 存储文件（ops-v1 操作流，通常仅几百字节）。
  app.get('/api/downloadreplay/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isReplayIdValid(id)) {
      return reply.code(404).send({ error: '回放不存在。' });
    }
    try {
      const raw = await replayStore.readRawReplay(id);
      return reply
        .header('Content-Disposition', `attachment; filename="roka-replay-${id}.rpl"`)
        .type('application/octet-stream')
        .send(raw);
    } catch {
      return reply.code(404).send({ error: '回放不存在。' });
    }
  });

  // 上传回放：客户端 POST 原始 .rpl 文件，服务端解码重建并转码为可观看的 RPB 二进制。
  app.post('/api/replay-upload', async (request, reply) => {
    const authUser = (request as AuthRequest).authUser;
    if (!authUser) {
      return reply.code(401).send({ error: '未登录或登录已失效。' });
    }
    try {
      const content = request.body;
      if (!Buffer.isBuffer(content) || content.length === 0) {
        throw new Error('empty body');
      }
      const replay = await replayStore.buildReplayFromRaw(content);
      const binary = encodeReplayPatchBinary(replay);
      return reply.type('application/octet-stream').send(binary);
    } catch {
      return reply.code(422).send({ error: '回放文件不兼容或已损坏。' });
    }
  });

  app.get('/api/replays', async (request, reply) => {
    const authUser = (request as AuthRequest).authUser;
    if (!authUser) {
      return reply.code(401).send({ error: '未登录或登录已失效。' });
    }

    const query = request.query as { offset?: unknown; limit?: unknown };
    const offsetRaw = Number.parseInt(String(query.offset ?? '0'), 10);
    const limitRaw = Number.parseInt(String(query.limit ?? '50'), 10);
    const offset = Number.isNaN(offsetRaw) || offsetRaw < 0 ? 0 : offsetRaw;
    const limit = Number.isNaN(limitRaw) || limitRaw <= 0 ? 50 : Math.min(limitRaw, 50);

    const allItems = await replayStore.listReplays();
    const items = allItems.slice(offset, offset + limit);
    const next_offset = offset + items.length;
    const has_more = next_offset < allItems.length;

    return reply.send({ items, next_offset, has_more });
  });

  app.get('/api/rooms', async (_request, reply) => {
    return reply.send(lobbyService.listLobbyRooms());
  });

  app.get('/api/map-examples', async (request, reply) => {
    const authUser = (request as AuthRequest).authUser;
    if (!authUser) {
      return reply.code(401).send({ error: '未登录或登录已失效。' });
    }

    const query = request.query as { map_mode?: unknown; players?: unknown };
    const mapModeRaw = String(query.map_mode ?? 'random');
    const mapMode = isMapExampleMode(mapModeRaw) ? mapModeRaw : 'random';
    const players = parseMapExamplePlayerCount(query.players);
    const example = await buildMapExample(mapMode, players);
    return reply.send({
      players,
      example,
    });
  });

  app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());

  app.setNotFoundHandler(async (request, reply) => {
    const reqPath = request.url.split('?')[0] || '/';
    if (reqPath === '/favicon.ico' || reqPath.startsWith('/api/') || reqPath.startsWith('/socket.io/')) {
      return reply.code(404).type('text/plain').send('Not Found');
    }
    if (reqPath.includes('.') && !reqPath.startsWith('/games/')) {
      return reply.code(404).type('text/plain').send('Not Found');
    }
    return reply.redirect(`/games/${lobbyService.randomRoomId()}`);
  });

  const io = new SocketIOServer(app.server, {
    transports: ['websocket', 'polling'],
  });
  authService.attachSocketServer(io);

  io.use((socket, next) => {
    const fromHandshake =
      typeof socket.handshake.auth?.token === 'string' ? String(socket.handshake.auth.token) : null;

    // Bot 令牌：命中 ROKA_BOT_TOKENS 时直接以对应用户名放行（合成用户）。
    if (fromHandshake) {
      const botUsername = botTokens.get(fromHandshake);
      if (botUsername) {
        socket.data.username = botUsername;
        next();
        return;
      }
    }

    const fromCookie = authService.getTokenFromCookie(socket.handshake.headers.cookie);
    const authUser = authService.verifyAuthToken(fromHandshake ?? fromCookie);

    if (!authUser) {
      next(new Error('未登录或登录已失效。'));
      return;
    }

    socket.data.username = authUser.username;
    next();
  });

  io.on('connection', (socket) => {
    const username = String(socket.data.username ?? '');
    if (!username) {
      socket.disconnect(true);
      return;
    }

    // 首页只接收全局失效通知：不参与「同一用户单连接」互斥，
    // 否则打开首页会踢掉该用户在游戏页/其他标签页的连接（反之亦然）。
    if (socket.handshake.query?.home === '1') {
      return;
    }

    authService.disconnectOtherUserSockets(username, socket.id);
    authService.trackSocket(username, socket.id);
    socket.join(`sid_${socket.id}`);
    socket.emit('set_id', lobbyService.md5(socket.id));

    socket.on(
      'attack',
      (data: { x: unknown; y: unknown; dx: unknown; dy: unknown; half: unknown; mode: unknown }) => {
        const gid = lobbyService.gameUid.get(socket.id);
        if (!gid) {
          return;
        }
        const parsedMode = Number.parseInt(String(data.mode), 10);
        const mode: MoveMode =
          parsedMode === 1 || parsedMode === 2
            ? parsedMode
            : parsedMode === 0
              ? 0
              : Boolean(data.half)
                ? 1
                : 0;
        lobbyService.gameInstances
          .get(gid)
          ?.addMove(
            socket.id,
            Number.parseInt(String(data.x), 10),
            Number.parseInt(String(data.y), 10),
            Number.parseInt(String(data.dx), 10),
            Number.parseInt(String(data.dy), 10),
            mode,
          );
      },
    );

    socket.on('build', (data: { x: unknown; y: unknown; op: unknown }) => {
      const gid = lobbyService.gameUid.get(socket.id);
      if (!gid) {
        return;
      }
      const op = data.op === 'c' ? 'c' : data.op === 'b' ? 'b' : null;
      if (!op) {
        return;
      }
      lobbyService.gameInstances
        .get(gid)
        ?.addBuild(socket.id, Number.parseInt(String(data.x), 10), Number.parseInt(String(data.y), 10), op);
    });

    socket.on('clear_queue', () => {
      const gid = lobbyService.gameUid.get(socket.id);
      if (!gid) {
        return;
      }
      lobbyService.gameInstances.get(gid)?.clearQueue(socket.id);
    });

    socket.on('pop_queue', () => {
      const gid = lobbyService.gameUid.get(socket.id);
      if (!gid) {
        return;
      }
      lobbyService.gameInstances.get(gid)?.popQueue(socket.id);
    });

    socket.on('join_game_room', (data: { room?: string }) => {
      const room = String(data.room ?? '').trim();
      if (room.length === 0 || room.length > 15) {
        return;
      }
      const roomVal = lobbyService.getLobbyVal(room);

      if (!lobbyService.lobbyOfSid.has(socket.id)) {
        lobbyService.joinLobby(socket.id, username, room);
        socket.join(`game_${roomVal}`);
        lobbyService.emitRoomUpdate(io, room);
        lobbyService.sendLobbySystemMessage(io, roomVal, `${username} 加入了自定义房间。`);
        lobbyService.emitHomeRooms(io);
        if (lobbyService.isLobbyGameRunning(room)) {
          lobbyService.gameInstances.get(roomVal)?.addSpectator(socket.id);
        }
      }
    });

    socket.on('change_team', (data: { team: unknown }) => {
      const gid = lobbyService.lobbyOfSid.get(socket.id);
      if (!gid) {
        return;
      }
      if (lobbyService.isLobbyGameRunning(gid)) {
        lobbyService.emitRoomUpdate(io, gid);
        return;
      }

      const conf = lobbyService.lobbyConfig.get(gid);
      if (!conf) {
        return;
      }

      let team = Number.parseInt(String(data.team), 10);
      if (Number.isNaN(team) || team < 0 || team > MAX_TEAMS) {
        return;
      }
      if (!conf.allow_team && team !== 0) {
        team = 1;
      }

      const players = lobbyService.lobbyPlayers.get(gid);
      if (!players) {
        return;
      }

      const player = players.find((item) => item.sid === socket.id);
      if (!player) {
        return;
      }

      const currentTeam = player.team;
      const isCurrentPlayer = currentTeam !== 0;
      const isNextPlayer = team !== 0;
      const playingCount = players.filter((item) => item.team !== 0).length;
      if (isNextPlayer && !isCurrentPlayer && playingCount >= MAX_TEAMS) {
        lobbyService.emitRoomUpdate(io, gid);
        return;
      }

      let nickname = username;
      player.team = team;
      if (team === 0) {
        player.ready = false;
      }
      nickname = player.uid;

      lobbyService.emitRoomUpdate(io, gid);
      const teamName = team === 0 ? '观战席' : conf.allow_team ? `队伍 ${team}` : '参赛者';
      lobbyService.sendLobbySystemMessage(
        io,
        lobbyService.getLobbyVal(gid),
        `${nickname} 加入了${teamName}。`,
      );
      lobbyService.emitHomeRooms(io);
    });

    socket.on('change_ready', (data: { ready: unknown }) => {
      const gid = lobbyService.lobbyOfSid.get(socket.id);
      if (!gid) {
        return;
      }
      if (lobbyService.isLobbyGameRunning(gid)) {
        lobbyService.emitRoomUpdate(io, gid);
        return;
      }

      const players = lobbyService.lobbyPlayers.get(gid);
      if (!players) {
        return;
      }

      for (const player of players) {
        if (player.sid === socket.id) {
          player.ready = player.team !== 0 && Boolean(data.ready);
          break;
        }
      }

      lobbyService.checkReady(io, gid);
      lobbyService.emitHomeRooms(io);
    });

    socket.on('change_game_conf', (data: Record<string, unknown>) => {
      try {
        const gid = lobbyService.lobbyOfSid.get(socket.id);
        if (!gid) {
          return;
        }
        if (lobbyService.isLobbyGameRunning(gid)) {
          lobbyService.emitRoomUpdate(io, gid);
          return;
        }

        const oldConf = lobbyService.lobbyConfig.get(gid);
        if (!oldConf) {
          return;
        }

        const players = lobbyService.lobbyPlayers.get(gid);
        if (!players) {
          return;
        }

        const roomVal = lobbyService.getLobbyVal(gid);
        const isHost = players[0]?.sid === socket.id || players[0]?.uid === username;
        if (!isHost) {
          lobbyService.emitRoomUpdate(io, gid);
          return;
        }

        const payload = data && typeof data === 'object' ? data : {};
        const nextConf: LobbyConfig = { ...oldConf };
        const changed: EditableLobbyKey[] = [];
        const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(payload, key);

        if (hasOwn('speed')) {
          const speed = lobbyService.parseFloatRange(payload.speed, 0.5, 4);
          if (speed !== oldConf.speed) {
            nextConf.speed = speed;
            changed.push('speed');
          }
        }

        if (hasOwn('allow_team')) {
          const allowTeamRaw = payload.allow_team;
          const allowTeam = Boolean(
            allowTeamRaw === true || allowTeamRaw === 1 || allowTeamRaw === '1' || allowTeamRaw === 'true',
          );
          if (allowTeam !== oldConf.allow_team) {
            nextConf.allow_team = allowTeam;
            changed.push('allow_team');
          }
        }

        if (hasOwn('map_mode')) {
          const mapModeRaw = String(payload.map_mode ?? oldConf.map_mode);
          let mapMode: LobbyConfig['map_mode'] = 'random';
          if (mapModeRaw === 'maze') {
            mapMode = 'maze';
          } else if (mapModeRaw === 'archipelago') {
            mapMode = 'archipelago';
          } else if (mapModeRaw === 'mediterranean') {
            mapMode = 'mediterranean';
          }
          if (mapMode !== oldConf.map_mode) {
            nextConf.map_mode = mapMode;
            changed.push('map_mode');
          }
        }

        if (hasOwn('map_token')) {
          const mapToken = lobbyService.normalizeMapToken(payload.map_token);
          if (mapToken !== oldConf.map_token) {
            nextConf.map_token = mapToken;
            changed.push('map_token');
          }
        }

        if (changed.length === 0) {
          return;
        }

        let playingCount = 0;
        for (const player of players) {
          if (player.team === 0) {
            continue;
          }
          if (playingCount >= MAX_TEAMS) {
            player.team = 0;
            player.ready = false;
            continue;
          }
          if (!nextConf.allow_team) {
            player.team = 1;
          }
          playingCount += 1;
        }

        lobbyService.lobbyConfig.set(gid, nextConf);

        lobbyService.emitRoomUpdate(io, gid);

        for (const key of changed) {
          lobbyService.sendLobbySystemMessage(
            io,
            roomVal,
            `${players[0].uid} 将${lobbyService.formatConfLabel(key)}改为 ${lobbyService.formatConfValue(key, nextConf[key])}。`,
          );
        }
        lobbyService.emitHomeRooms(io);
      } catch {
        return;
      }
    });

    socket.on('send_message', (data: { text: string; team: boolean }) => {
      const text = String(data.text ?? '').trim();
      if (!text) {
        return;
      }

      const gid = lobbyService.gameUid.get(socket.id);
      if (gid) {
        lobbyService.gameInstances.get(gid)?.sendMessage(socket.id, {
          text,
          team: Boolean(data.team),
        });
        return;
      }

      const lobbyId = lobbyService.lobbyOfSid.get(socket.id);
      if (!lobbyId) {
        return;
      }

      const players = lobbyService.lobbyPlayers.get(lobbyId);
      if (!players) {
        return;
      }

      let color = 0;
      let uid = username;
      for (let i = 0; i < players.length; i += 1) {
        if (players[i].sid === socket.id) {
          color = i + 1;
          uid = players[i].uid;
          break;
        }
      }

      lobbyService.sendSystemMessage(io, lobbyService.getLobbyVal(lobbyId), 'room', uid, color, text);
      lobbyService.relayGlobalChat(io, lobbyService.getLobbyVal(lobbyId), lobbyId, uid, color, text);
    });

    socket.on('surrender', () => {
      const gid = lobbyService.gameUid.get(socket.id);
      if (!gid) {
        return;
      }
      lobbyService.gameInstances.get(gid)?.surrender(socket.id);
    });

    const doReturnRoom = (): void => {
      const changed = lobbyService.returnToRoom(io, socket.id);
      if (changed || lobbyService.lobbyOfSid.has(socket.id)) {
        io.to(`sid_${socket.id}`).emit('left', {});
      }
    };

    socket.on('return_room', doReturnRoom);
    socket.on('leave', doReturnRoom);

    socket.on('disconnect', () => {
      authService.untrackSocket(username, socket.id);
      socket.leave(`sid_${socket.id}`);
      lobbyService.checkLeave(io, socket.id, (room) => {
        socket.leave(room);
      });
    });
  });

  const cliPortIndex = process.argv.indexOf('--port');
  const cliPort = cliPortIndex >= 0 ? Number(process.argv[cliPortIndex + 1]) : Number.NaN;
  const port = Number.isFinite(cliPort) && cliPort > 0 ? cliPort : Number(process.env.PORT) || 23333;
  await app.listen({ host: '0.0.0.0', port });
};

void boot();
