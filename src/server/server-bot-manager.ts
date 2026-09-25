import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

/**
 * 服务端托管策略 Bot 管理器（超级管理员在后台管理页启动/停止）。
 *
 * 运行方式：不另起进程，直接在服务器进程内用 socket.io-client 连接本机回环
 * 地址完成完整的 socket 握手。鉴权走与 ROKA_BOT_TOKENS 相同的中间件路径——
 * 每次启动生成一个随机内存令牌（令牌 → bot 信息），连接命中即视为 bot
 * （isBot，豁免房间心跳踢出）并额外标记 isServerBot（进房时不当房主）。
 * 令牌仅存内存、不出现在任何公开接口，Bot 停止即删除。
 *
 * 模板发现：自动枚举 bot-template/ 一级子目录，把带 strategy.js 或
 * server-bot.js 且导出 attachStrategy 的目录作为可托管模板（如
 * simple-strategy-bot、anti-human-bot）；random-patch-bot 是 CLI 参考模板，
 * 模块加载即连接服务器，不作为可托管选项。模板按目录名缓存加载。
 *
 * 重启自动恢复（issue #28）：start/stop 时把运行中 bot 的
 * {username, room, template, allowTeam} 列表同步写入 stateFilePath（JSON，
 * 临时文件 + rename 原子替换）；服务器重启后由 restore() 读回，逐条重做与
 * 手动启动相同的校验（用户存在且未封禁、房间号长度 1~15、模板可加载），
 * 全部通过才以原配置自动启动；失效记录只记警告并随成功启动的写盘清除，
 * 不影响服务器启动。缺少 template/allowTeam 的旧记录按 simple-strategy-bot +
 * allowTeam=false 恢复，维持旧行为。
 */

interface StrategyOptions {
  room: string;
  team?: number;
  autoReady?: boolean;
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
  template: string;
  allowTeam: boolean;
  startedAt: number;
  connected: boolean;
}

interface BotTemplateInfo {
  /** 模板 ID（严格为 bot-template/ 下的目录名）。 */
  id: string;
  /** 展示名（package.json 的 name，读取失败时退回目录名）。 */
  name: string;
  /** 描述（package.json 的 description，可能为空）。 */
  description: string;
}

interface RunningServerBot extends ServerBotInfo {
  token: string;
  socket: ClientSocket;
  handle: StrategyHandle;
}

interface ServerBotManagerOptions {
  /** 服务器实际监听端口（start 时读取，API 调用必然发生在 listen 之后）。 */
  getPort: () => number;
  /** 自动恢复状态文件（JSON）：运行中 bot 的 {username, room, template, allowTeam} 列表。 */
  stateFilePath: string;
}

/** 状态文件中单条 bot 记录：恢复所需的全部配置。 */
interface SavedServerBot {
  username: string;
  room: string;
  template?: string;
  allowTeam?: boolean;
}

/** 内存临时令牌表项：token → bot 身份与组队许可，供 server.ts 的 socket 中间件查询。 */
interface TokenEntry {
  username: string;
  allowTeam: boolean;
}

const BOT_TEMPLATE_DIR = path.join('bot-template');
const DEFAULT_TEMPLATE = 'simple-strategy-bot';

class ServerBotManager {
  private readonly bots = new Map<string, RunningServerBot>();
  /** 内存临时令牌表：token → bot 信息，供 server.ts 的 socket 中间件查询。 */
  private readonly tokens = new Map<string, TokenEntry>();

  /** 模板 ID → 策略模块缓存，不同模板分别加载。 */
  private readonly strategyModules = new Map<string, StrategyModule>();

  constructor(private readonly options: ServerBotManagerOptions) {}

  /** socket 中间件用：命中内存临时令牌时返回对应 bot 信息，否则返回 null。 */
  resolveToken(token: string): TokenEntry | null {
    return this.tokens.get(token) ?? null;
  }

  list(): ServerBotInfo[] {
    return [...this.bots.values()].map((bot) => ({
      id: bot.id,
      username: bot.username,
      room: bot.room,
      template: bot.template,
      allowTeam: bot.allowTeam,
      startedAt: bot.startedAt,
      connected: bot.socket.connected,
    }));
  }

  /**
   * 枚举 bot-template/ 一级子目录中的可托管模板：存在 strategy.js 或
   * server-bot.js 且导出 attachStrategy 的目录入选；模板 ID 严格为目录名。
   */
  listTemplates(): BotTemplateInfo[] {
    const templates: BotTemplateInfo[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(path.join(process.cwd(), BOT_TEMPLATE_DIR), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return templates;
    }
    for (const id of entries.sort()) {
      const dir = path.join(process.cwd(), BOT_TEMPLATE_DIR, id);
      if (!this.findStrategyEntry(dir)) {
        continue;
      }
      try {
        this.loadStrategy(id);
      } catch {
        continue;
      }
      let name = id;
      let description = '';
      try {
        const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
          name?: unknown;
          description?: unknown;
        };
        if (typeof pkg.name === 'string' && pkg.name.length > 0) {
          name = pkg.name;
        }
        if (typeof pkg.description === 'string') {
          description = pkg.description;
        }
      } catch {
        // 读取失败时退回目录名展示
      }
      templates.push({ id, name, description });
    }
    return templates;
  }

  start(username: string, room: string, templateId: string, allowTeam: boolean): ServerBotInfo {
    for (const bot of this.bots.values()) {
      if (bot.username === username) {
        throw new Error(`用户 ${username} 已有运行中的策略 Bot。`);
      }
      if (bot.room === room) {
        throw new Error(`房间 ${room} 已有运行中的策略 Bot（用户 ${bot.username}）。`);
      }
    }

    const strategy = this.loadStrategy(templateId);
    const token = randomBytes(24).toString('hex');
    const id = randomBytes(6).toString('hex');

    const socket = ioClient(`http://127.0.0.1:${this.options.getPort()}`, {
      transports: ['websocket', 'polling'],
      auth: { token },
      reconnection: true,
    });

    const handle = strategy.attachStrategy(socket, {
      room,
      team: 1,
      autoReady: true,
      log: (message) => console.log(`[server-bot] ${username}: ${message}`),
    });

    const bot: RunningServerBot = {
      id,
      username,
      room,
      template: templateId,
      allowTeam,
      startedAt: Date.now(),
      connected: false,
      token,
      socket,
      handle,
    };
    this.bots.set(id, bot);
    this.tokens.set(token, { username, allowTeam });
    this.persistState();
    console.log(
      `[server-bot] ${username}: started in room ${room} (template=${templateId}, allowTeam=${allowTeam}, id=${id})`,
    );
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
    this.persistState();
    console.log(`[server-bot] ${bot.username}: stopped (id=${id})`);
    return true;
  }

  /**
   * 重启后自动恢复（listen 完成后调用）：逐条读取状态文件，重做与手动启动
   * 相同的校验（validateUsername 判断用户存在且未封禁；房间号长度 1~15；
   * 模板经 loadStrategy 试加载），全部通过才以原配置启动。任何一条失效
   * 只记警告跳过——成功启动的 bot 会触发 persistState，自动清掉失效记录。
   */
  restore(validateUsername: (username: string) => boolean): void {
    for (const saved of this.readState()) {
      try {
        if (!validateUsername(saved.username)) {
          throw new Error(`用户 ${saved.username} 不存在或已被封禁。`);
        }
        if (saved.room.length === 0 || saved.room.length > 15) {
          throw new Error(`房间号无效（长度 1~15）。`);
        }
        // 旧记录缺少 template/allowTeam：按 simple-strategy-bot + 不允许组队恢复。
        const template = saved.template ?? DEFAULT_TEMPLATE;
        const allowTeam = saved.allowTeam === true;
        this.loadStrategy(template);
        this.start(saved.username, saved.room, template, allowTeam);
        console.log(
          `[server-bot] ${saved.username}: 已按重启前配置自动恢复（房间 ${saved.room}，模板 ${template}，组队 ${allowTeam ? '允许' : '不允许'}）`,
        );
      } catch (error) {
        console.warn(
          `[server-bot] ${saved.username}: 自动恢复失败，已跳过：${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  /** 读取状态文件；文件缺失/损坏/结构不符均按无状态处理（返回空数组）。 */
  private readState(): SavedServerBot[] {
    let raw: string;
    try {
      raw = readFileSync(this.options.stateFilePath, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(
        (item): item is SavedServerBot =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as SavedServerBot).username === 'string' &&
          typeof (item as SavedServerBot).room === 'string',
      );
    } catch {
      console.warn(`[server-bot] 状态文件解析失败，按无状态处理：${this.options.stateFilePath}`);
      return [];
    }
  }

  /** 把运行中 bot 列表写入状态文件（临时文件 + rename 原子替换）；写盘失败只记警告。 */
  private persistState(): void {
    try {
      const snapshot: SavedServerBot[] = [...this.bots.values()].map((bot) => ({
        username: bot.username,
        room: bot.room,
        template: bot.template,
        allowTeam: bot.allowTeam,
      }));
      mkdirSync(path.dirname(this.options.stateFilePath), { recursive: true });
      const tmpPath = `${this.options.stateFilePath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
      renameSync(tmpPath, this.options.stateFilePath);
    } catch (error) {
      console.warn(`[server-bot] 状态文件写入失败：${error instanceof Error ? error.message : error}`);
    }
  }

  /** 在模板目录内查找托管适配入口（strategy.js 优先于 server-bot.js）。 */
  private findStrategyEntry(dir: string): string | null {
    for (const entry of ['strategy.js', 'server-bot.js']) {
      if (existsSync(path.join(dir, entry))) {
        return entry;
      }
    }
    return null;
  }

  private loadStrategy(templateId: string): StrategyModule {
    const cached = this.strategyModules.get(templateId);
    if (cached) {
      return cached;
    }
    // 模板 ID 严格限定为 bot-template/ 一级目录名，路径解析保持在模板根内。
    const dir = path.join(process.cwd(), BOT_TEMPLATE_DIR, templateId);
    const entry = this.findStrategyEntry(dir);
    if (!entry) {
      throw new Error(`模板 ${templateId} 不存在或不可托管（缺少 strategy.js / server-bot.js）。`);
    }
    // 与 fastifyStatic 一致按 process.cwd() 解析仓库根目录；strategy.js /
    // server-bot.js 是 plain JS（CLI 与服务端共用），不经 tsc 编译，故用
    // createRequire 动态加载。
    const localRequire = createRequire(path.join(process.cwd(), 'package.json'));
    const loaded = localRequire(path.join(dir, entry)) as StrategyModule;
    if (typeof loaded?.attachStrategy !== 'function') {
      throw new Error(`模板 ${templateId} 的 ${entry} 缺少 attachStrategy 导出。`);
    }
    this.strategyModules.set(templateId, loaded);
    return loaded;
  }
}

export { ServerBotManager };
export type { BotTemplateInfo, ServerBotInfo };
