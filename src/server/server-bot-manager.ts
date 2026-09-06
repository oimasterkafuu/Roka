import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

/**
 * 服务端托管策略 Bot 管理器（超级管理员在后台管理页启动/停止）。
 *
 * 运行方式：不另起进程，直接在服务器进程内用 socket.io-client 连接本机回环
 * 地址完成完整的 socket 握手。鉴权走与 ROKA_BOT_TOKENS 相同的中间件路径——
 * 每次启动生成一个随机内存令牌（令牌 → 用户名），连接命中即视为 bot
 * （isBot，豁免房间心跳踢出）并额外标记 isServerBot（进房时不当房主）。
 * 令牌仅存内存、不出现在任何公开接口，Bot 停止即删除。
 *
 * 策略实现复用 bot-template/simple-strategy-bot/strategy.js（与 CLI 运行
 * 同一份代码），按项目约定以 process.cwd() 为根解析。
 */

interface StrategyOptions {
  room: string;
  log: (message: string) => void;
}

interface StrategyHandle {
  stop: () => void;
}

interface StrategyModule {
  attachStrategy: (socket: ClientSocket, options: StrategyOptions) => StrategyHandle;
}

interface ServerBotInfo {
  id: string;
  username: string;
  room: string;
  startedAt: number;
  connected: boolean;
}

interface RunningServerBot extends ServerBotInfo {
  token: string;
  socket: ClientSocket;
  handle: StrategyHandle;
}

interface ServerBotManagerOptions {
  /** 服务器实际监听端口（start 时读取，API 调用必然发生在 listen 之后）。 */
  getPort: () => number;
}

const STRATEGY_RELATIVE_PATH = path.join('bot-template', 'simple-strategy-bot', 'strategy.js');

class ServerBotManager {
  private readonly bots = new Map<string, RunningServerBot>();
  /** 内存临时令牌表：token → username，供 server.ts 的 socket 中间件查询。 */
  private readonly tokens = new Map<string, string>();

  private strategyModule: StrategyModule | null = null;

  constructor(private readonly options: ServerBotManagerOptions) {}

  /** socket 中间件用：命中内存临时令牌时返回对应用户名，否则返回 null。 */
  resolveToken(token: string): string | null {
    return this.tokens.get(token) ?? null;
  }

  list(): ServerBotInfo[] {
    return [...this.bots.values()].map((bot) => ({
      id: bot.id,
      username: bot.username,
      room: bot.room,
      startedAt: bot.startedAt,
      connected: bot.socket.connected,
    }));
  }

  start(username: string, room: string): ServerBotInfo {
    for (const bot of this.bots.values()) {
      if (bot.username === username) {
        throw new Error(`用户 ${username} 已有运行中的策略 Bot。`);
      }
    }

    const strategy = this.loadStrategy();
    const token = randomBytes(24).toString('hex');
    const id = randomBytes(6).toString('hex');

    const socket = ioClient(`http://127.0.0.1:${this.options.getPort()}`, {
      transports: ['websocket', 'polling'],
      auth: { token },
      reconnection: true,
    });

    const handle = strategy.attachStrategy(socket, {
      room,
      log: (message) => console.log(`[server-bot] ${username}: ${message}`),
    });

    const bot: RunningServerBot = {
      id,
      username,
      room,
      startedAt: Date.now(),
      connected: false,
      token,
      socket,
      handle,
    };
    this.bots.set(id, bot);
    this.tokens.set(token, username);
    console.log(`[server-bot] ${username}: started in room ${room} (id=${id})`);
    return this.list().find((item) => item.id === id) as ServerBotInfo;
  }

  stop(id: string): boolean {
    const bot = this.bots.get(id);
    if (!bot) {
      return false;
    }
    this.bots.delete(id);
    this.tokens.delete(bot.token);
    bot.handle.stop();
    bot.socket.disconnect();
    console.log(`[server-bot] ${bot.username}: stopped (id=${id})`);
    return true;
  }

  private loadStrategy(): StrategyModule {
    if (this.strategyModule) {
      return this.strategyModule;
    }
    // 与 fastifyStatic 一致按 process.cwd() 解析仓库根目录；strategy.js 是
    // plain JS（CLI 与服务端共用），不经 tsc 编译，故用 createRequire 动态加载。
    const strategyPath = path.join(process.cwd(), STRATEGY_RELATIVE_PATH);
    const localRequire = createRequire(path.join(process.cwd(), 'package.json'));
    const loaded = localRequire(strategyPath) as StrategyModule;
    if (typeof loaded?.attachStrategy !== 'function') {
      throw new Error('策略模块缺少 attachStrategy 导出。');
    }
    this.strategyModule = loaded;
    return loaded;
  }
}

export { ServerBotManager };
export type { ServerBotInfo };
