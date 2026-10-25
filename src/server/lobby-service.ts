import { createHash, randomBytes } from 'node:crypto';
import { Server as SocketIOServer } from 'socket.io';
import { getGamePoints, UserStore } from '../auth-store';
import { GameDisciplineEvent, GameEngine } from '../game-engine';
import {
  AFK_WINDOW_MS,
  evaluateAutomaticDiscipline,
  isRapidSurrender,
  RAPID_SURRENDER_WINDOW_MS,
  shouldResetAutomaticBanCount,
} from './auto-ban-policy';
import { DISCONNECT_GRACE_MS } from '../game-engine/constants';
import { isHuaxiaSeasonActive } from '../map/huaxia-season';
import { resolveMapSizeRatioByPlayersAndRegion } from '../map/map-size';
import { DEFAULT_MAP_REGION, getHuaxiaRegion, normalizeMapRegion } from '../map/huaxia-regions';
import { ReplayStore } from '../replay-store';
import {
  ChatScope,
  GameConfig,
  GameResultEntry,
  LobbyConfig,
  LobbyPlayer,
  MAX_TEAMS,
  RoomListItem,
  RoomUpdatePayload,
  ChatFoldPayload,
} from '../types';

type EditableLobbyKey =
  'speed' | 'allow_team' | 'fog' | 'multi_line' | 'map_mode' | 'map_region' | 'map_token' | 'map_size';

const FIXED_WIDTH_RATIO = 0.5;
const FIXED_HEIGHT_RATIO = 0.5;
const FIXED_CITY_RATIO = 0.5;
const FIXED_MOUNTAIN_RATIO = 0.5;
const FIXED_SWAMP_RATIO = 0.5;
export { FIXED_SWAMP_RATIO };
const MAP_TOKEN_MAX_LENGTH = 32;
const RATING_K = 128;
/** 房间准备阶段的心跳超时：超过 600 秒无心跳的成员被自动移出房间。 */
const LOBBY_HEARTBEAT_TIMEOUT_MS = 600_000;
/** 心跳扫描周期：每分钟检查一次全部房间成员的最后心跳时间。 */
const LOBBY_HEARTBEAT_SWEEP_MS = 60_000;
/** 房间停留上限：成员（含观战）单次在房累计超过 12 小时即移出（对局进行中除外），
 * 防止挂着的浏览器标签页靠心跳长期占用房间席位并维持在线状态。 */
const LOBBY_MAX_DWELL_MS = 12 * 3600_000;

/** 非官方 AI（与房间 AI 标记一致：未通过 humanVerified 且非托管 Bot）每日
 *（服务器本地日历日）在官方 Bot 房间的累计停留上限；达到上限后自动移出，
 * 且当日无法再进入任何官方 Bot 房间。人类与官方托管 Bot 不受影响。 */
const BOT_DWELL_DAILY_LIMIT_MS = 4 * 3600_000;

const confStr: Record<EditableLobbyKey, string> = {
  speed: '游戏速度',
  allow_team: '允许组队',
  fog: '迷雾远征',
  multi_line: '多线争锋',
  map_mode: '地图类型',
  map_region: '华夏地区',
  map_token: '地图随机种子',
  map_size: '地图大小',
};

/**
 * 掉线宽限期中的待重连记录，键为 `${gameId}:${username}`。
 * timer 到期仍未重连则以「挂机」投降并执行完整离开清理。
 */
interface PendingRejoin {
  gameId: string;
  lobbyId: string;
  oldSid: string;
  /** 旧连接是否为 bot 连接（socket.data.isBot），供 tryRejoin 做身份匹配。 */
  isBot: boolean;
  timer: NodeJS.Timeout;
}

class LobbyService {
  readonly gameUid = new Map<string, string>();
  readonly gameInstances = new Map<string, GameEngine>();
  readonly gameLobbyId = new Map<string, string>();
  readonly gamePlayers = new Map<string, Set<string>>();

  readonly lobbyRoomValue = new Map<string, string>();
  readonly lobbyOfSid = new Map<string, string>();
  readonly lobbyConfig = new Map<string, LobbyConfig>();
  readonly lobbyPlayers = new Map<string, LobbyPlayer[]>();

  private readonly pendingRejoins = new Map<string, PendingRejoin>();

  /** 房间成员的最后心跳时间（sid → ms 时间戳）；仅用于准备阶段的掉线检测。 */
  private readonly lobbyHeartbeats = new Map<string, number>();
  /** 房间成员本次进房的时间（sid → ms 时间戳）；重进房间时重置，用于停留上限检测。 */
  private readonly lobbyJoinedAt = new Map<string, number>();

  /** 非官方 AI 在官方 Bot 房间的进行中计时段（sid → {uid, gid, sinceMs}）；
   * 只记进房时房内已有托管 Bot 成员的记录（快照判定，进入后官方 Bot 离开不追溯）。 */
  private readonly botDwell = new Map<string, { uid: string; gid: string; sinceMs: number }>();

  /** 非官方 AI 每日（服务器本地日历日 YYYY-MM-DD）在官方 Bot 房间的累计停留毫秒数；
   * 每次读写时惰性 rollover（date 不同即重置该 uid 桶）。内存态，服务器重启清零。 */
  private readonly botDwellDaily = new Map<string, { date: string; ms: number }>();
  /** 豁免心跳踢出的 sid（ROKA_BOT_TOKENS 鉴权的 bot 连接，由 server.ts 维护）。 */
  readonly heartbeatExempt = new Set<string>();
  /**
   * 已通过真人客户端认证的连接 sid 集合（由 server.ts 在常规事件校验后写入）。
   * 用于进房时的房主排序与客户端验证兼容，不作为 AI 判定依据。
   */
  readonly humanVerified = new Set<string>();
  private heartbeatSweepTimer?: NodeJS.Timeout;

  /** 对局全部结束时触发（例如让推迟中的自动更新继续执行）。 */
  onGameEnded?: () => void;

  /**
   * 部署更新排队状态：webhook 已触发自动更新但还有对局在跑。
   * 排队期间禁止开新局（room_update 携带 update_queued，前端禁用开始按钮），
   * 进行中的对局页面显示「系统即将更新」横幅。
   */
  private updateQueued = false;

  constructor(
    private readonly replayStore: ReplayStore,
    private readonly userStore: UserStore,
    private readonly disconnectUser?: (username: string) => void,
  ) {}

  private isBotUsername(username: string): boolean {
    for (const players of this.lobbyPlayers.values()) {
      if (players.some((player) => player.uid === username && player.bot === true)) {
        return true;
      }
    }
    return false;
  }

  private async handleDisciplineEvent(event: GameDisciplineEvent): Promise<void> {
    if (this.isBotUsername(event.username)) return;
    const type =
      event.cause === 'afk'
        ? 'afk'
        : isRapidSurrender(event)
          ? 'rapid_surrender'
          : event.cause === 'leave'
            ? 'leave'
            : event.cause === 'disconnect_timeout'
              ? 'disconnect_timeout'
              : 'normal_surrender';
    const previous = this.userStore
      .listDisciplineEvents(event.username)
      .filter((item) => item.type === 'afk' || item.type === 'rapid_surrender')
      .map((item) => ({
        cause: item.type === 'afk' ? ('afk' as const) : ('manual_surrender' as const),
        turn: item.turn,
        elapsedMs: item.elapsedMs,
        occurredAt: item.occurredAt,
        playerCount: item.playerCount,
      }));
    await this.userStore.recordDisciplineEvent(event.username, {
      occurredAt: event.occurredAt,
      type,
      turn: event.turn,
      elapsedMs: event.elapsedMs,
      evidence: `${event.cause} at turn ${event.turn}`,
      playerCount: event.playerCount,
    });
    if (type !== 'afk' && type !== 'rapid_surrender') return;
    // 梯度重置：不含当前事件的历史中，最近一次违规距今满 14 天则清零重新累计。
    if (shouldResetAutomaticBanCount(previous, event.occurredAt)) {
      await this.userStore.resetAutomaticBanCount(event.username);
    }
    const decision = evaluateAutomaticDiscipline(
      event,
      previous,
      event.occurredAt,
      this.userStore.getAutomaticBanCount(event.username),
    );
    if (!decision) return;
    await this.userStore.applyAutomaticDiscipline(
      event.username,
      decision.bannedUntil,
      decision.type,
      event.occurredAt,
      `${decision.triggerCount} events within ${type === 'afk' ? AFK_WINDOW_MS : RAPID_SURRENDER_WINDOW_MS}ms`,
    );
    await this.userStore.clearSession(event.username);
    this.disconnectUser?.(event.username);
  }

  md5(input: string): string {
    return createHash('md5').update(input, 'utf-8').digest('hex');
  }

  randomHexToken(): string {
    return randomBytes(16).toString('hex');
  }

  normalizeMapToken(value: unknown, fallback?: string): string {
    const token = String(value ?? '')
      .trim()
      .slice(0, MAP_TOKEN_MAX_LENGTH);
    if (token.length > 0) {
      return token;
    }
    return String(fallback ?? this.randomHexToken())
      .trim()
      .slice(0, MAP_TOKEN_MAX_LENGTH);
  }

  randomRoomId(): string {
    return Array.from({ length: 4 }, () =>
      String.fromCharCode('a'.charCodeAt(0) + Math.floor(Math.random() * 26)),
    ).join('');
  }

  isLobbyGameRunning(gid: string): boolean {
    return this.gameInstances.has(this.getLobbyVal(gid));
  }

  /**
   * 成员当前席位名称（进出广播文案用，issue #122）：观战席成员——team 0，
   * 或对局进行中但并非该局存活参赛者（中途进房的观战者、已出局留观玩家）——
   * 为「观战席」，其余参战成员为「自定义房间」。
   */
  lobbySeatName(lobbyId: string, sid: string): string {
    const member = this.lobbyPlayers.get(lobbyId)?.find((player) => player.sid === sid);
    if (!member) {
      return '自定义房间';
    }
    if (member.team === 0) {
      return '观战席';
    }
    const game = this.gameInstances.get(this.getLobbyVal(lobbyId));
    if (game && !game.isActiveParticipant(sid)) {
      return '观战席';
    }
    return '自定义房间';
  }

  hasActiveGames(): boolean {
    return this.gameInstances.size > 0;
  }

  isUpdateQueued(): boolean {
    return this.updateQueued;
  }

  /**
   * 切换部署更新排队状态：广播 deploy_queued 事件（对局页显示「系统即将更新」
   * 横幅）并向所有房间重发 room_update（携带 update_queued，前端禁用开始按钮）。
   * 进入排队时向有对局的房间发送提示消息，说明宽限期清算规则。
   */
  setUpdateQueued(io: SocketIOServer, queued: boolean, graceMs?: number): void {
    if (this.updateQueued === queued) {
      return;
    }
    this.updateQueued = queued;
    io.emit('deploy_queued', { queued });
    for (const [gid, players] of this.lobbyPlayers.entries()) {
      if (players.length === 0) {
        continue;
      }
      if (queued && this.isLobbyGameRunning(gid)) {
        const graceSeconds = Math.round((graceMs ?? 120_000) / 1000);
        this.sendLobbySystemMessage(
          io,
          this.getLobbyVal(gid),
          `系统即将更新，${graceSeconds} 秒内未结束的对局将按当前名次结算。`,
        );
      }
      this.emitRoomUpdate(io, gid);
    }
  }

  /**
   * 部署更新宽限期到期（webhook-updater 回调）：清算所有残余对局——按当前
   * 排行榜名次走正常终局路径结算（回放存档 + rating + 房间清理由各对局的
   * endGame 回调完成），随后 notifyGameEnded 接力开始更新重启。
   */
  settleActiveGamesForUpdate(endMessage: string): void {
    for (const game of this.gameInstances.values()) {
      void game.forceFinish(endMessage).catch(() => undefined);
    }
  }

  getLobbyVal(gid: string): string {
    let value = this.lobbyRoomValue.get(gid);
    if (!value) {
      value = this.md5(`${gid}:${Date.now()}:${Math.random()}`);
      this.lobbyRoomValue.set(gid, value);
    }
    return value;
  }

  joinLobby(
    sid: string,
    uid: string,
    gid: string,
    options?: {
      serverBot?: boolean;
      serverBotAllowTeam?: boolean;
      serverBotAllowFog?: boolean;
      serverBotAllowMultiLine?: boolean;
      bot?: boolean;
    },
  ): { blocked?: string } {
    // 非官方 AI 的官方 Bot 房每日停留上限：AI 身份与房间标记共用 humanVerified，
    // 不看 JWT、ROKA_BOT_TOKENS 或 socket.data.isBot；官方托管 Bot 除外。
    // 官方 Bot 房按进房时刻快照判定（进入后官方 Bot 离开不追溯）。
    const isUnofficialAi = options?.serverBot !== true && !this.humanVerified.has(sid);
    const isServerBotRoom = (this.lobbyPlayers.get(gid) ?? []).some((player) => player.serverBot === true);
    if (isUnofficialAi && isServerBotRoom && this.botDwellTotalMs(uid) >= BOT_DWELL_DAILY_LIMIT_MS) {
      return { blocked: `${uid} 今日在官方 Bot 房间的累计停留已达 4 小时上限，暂时无法进入。` };
    }

    this.lobbyOfSid.set(sid, gid);
    // 进房本身即是「标签页开启」的证明，作为心跳基线；同时记录进房时间作为停留上限基线。
    this.lobbyHeartbeats.set(sid, Date.now());
    this.lobbyJoinedAt.set(sid, Date.now());
    const existingPlayers = this.lobbyPlayers.get(gid);
    const isNewRoom = !existingPlayers || existingPlayers.length === 0;

    if (isNewRoom) {
      this.lobbyConfig.set(gid, this.defaultLobbyConfig());
    }
    if (!this.lobbyPlayers.has(gid)) {
      this.lobbyPlayers.set(gid, []);
    }

    const players = this.lobbyPlayers.get(gid);
    const conf = this.lobbyConfig.get(gid);
    if (!players || !conf) {
      return {};
    }

    const isBot = options?.serverBot === true || options?.bot === true;
    const playingCount = players.filter((player) => player.team !== 0).length;
    let targetTeam = 0;

    if (playingCount < MAX_TEAMS) {
      if (!conf.allow_team) {
        targetTeam = 1;
      } else {
        // 服务端不再按 bot/人类分池：进房默认分配到人数最少的队伍，
        // 想换队由成员自己发 change_team（bot 自行管理避让，见 bot 模板）。
        targetTeam = this.pickLeastPopulatedTeam(players);
      }
    }

    const player: LobbyPlayer = { sid, uid, team: targetTeam, ready: false };
    if (isBot) {
      // 第三方 Bot 与未允许迷雾的托管 Bot 不支持迷雾远征：进房时若迷雾已开启
      // 则强制关闭，房主后续重新开启的请求在 server.ts 的 change_game_conf 里拦截。
      player.bot = true;
      if (conf.fog && (options?.serverBot !== true || options.serverBotAllowFog !== true)) {
        conf.fog = false;
      }
      // 多线争锋同理：第三方 Bot 与未允许多线的托管 Bot 进房时强制关闭多线争锋。
      if (conf.multi_line && (options?.serverBot !== true || options.serverBotAllowMultiLine !== true)) {
        conf.multi_line = false;
      }
    }
    if (options?.serverBot) {
      // 托管策略 Bot 的组队语义由启动参数决定（serverBotAllowTeam）：
      // allowTeam=false 的房间强制关闭组队并规整队伍；allowTeam=true 时不强制
      // 开启组队，仅移除 change_game_conf 的组队开关限制，由房主决定是否启用。
      player.serverBot = true;
      player.serverBotAllowTeam = options.serverBotAllowTeam === true;
      player.serverBotAllowFog = options.serverBotAllowFog === true;
      player.serverBotAllowMultiLine = options.serverBotAllowMultiLine === true;
      if (options.serverBotAllowTeam !== true && conf.allow_team) {
        // 不允许组队的托管 bot：进房强制关闭组队并规整队伍。
        conf.allow_team = false;
        this.enforceLobbyConstraints(gid);
      }
      // 服务端托管 bot 永远排在普通成员之后：房主（players[0]）保留给
      // 人类用户或第三方 bot。bot 单独在房时暂居首位，任何普通成员进房即接任。
      players.push(player);
      return {};
    }
    // 房主优先级三档（首次补验真人时也由 reorderLobbyForVerification 稳定重排）：
    // 1) 人类（humanVerified 已命中）：插在最后一个既有普通人类之后——
    //    任何人类进房后，房主自动归「第一个人类」；
    // 2) 非官方 AI（令牌 bot、第三方 bot、未通过真人校验的普通连接）：
    //    无人类在座时排在首位接任房主，有人类则排在人类之后、托管 bot 之前；
    // 3) 服务端托管 bot：永远排尾（上面已处理）。
    const isHuman = this.humanVerified.has(sid);
    let insertIndex = 0;
    if (isHuman) {
      while (insertIndex < players.length && this.humanVerified.has(players[insertIndex].sid)) {
        insertIndex += 1;
      }
    } else {
      while (insertIndex < players.length && players[insertIndex].serverBot !== true) {
        insertIndex += 1;
      }
    }
    players.splice(insertIndex, 0, player);
    if (isUnofficialAi && isServerBotRoom) {
      // 非官方 AI 进入官方 Bot 房：开始计时段（退出时由 leaveLobby 结算进当日桶）。
      this.botDwell.set(sid, { uid, gid, sinceMs: Date.now() });
    }
    return {};
  }

  leaveLobby(sid: string, gid: string): string {
    // 官方 Bot 房停留计时结算：所有退出路径（checkLeave/kickFromLobby/断线宽限到期/
    // 对局结束清理）都汇聚到本方法，有计时段则累加进当日桶并清除。
    this.settleBotDwell(sid);
    const players = this.lobbyPlayers.get(gid);
    if (!players) {
      return '';
    }
    const index = players.findIndex((player) => player.sid === sid);
    if (index === -1) {
      return '';
    }
    const [removed] = players.splice(index, 1);
    return removed.uid;
  }

  /** 服务器本地时区的日历日键（YYYY-MM-DD），用于每日停留桶的惰性 rollover。 */
  private localDateKey(): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  }

  /** 某 uid 当日在官方 Bot 房间的累计停留毫秒数（date 不同即视为 0，惰性 rollover）。 */
  private botDwellDailyMs(uid: string): number {
    const bucket = this.botDwellDaily.get(uid);
    if (!bucket || bucket.date !== this.localDateKey()) {
      return 0;
    }
    return bucket.ms;
  }

  /** 当日已累计时间与该 uid 所有进行中计时段之和，供进房拦截和自动踢出共用。 */
  private botDwellTotalMs(uid: string, now = Date.now()): number {
    let total = this.botDwellDailyMs(uid);
    for (const record of this.botDwell.values()) {
      if (record.uid === uid) {
        total += Math.max(0, now - record.sinceMs);
      }
    }
    return total;
  }

  /** 把一段停留累加进某 uid 的当日桶（date 不同即重置该桶后再累加，惰性 rollover）。 */
  private addBotDwellDaily(uid: string, ms: number): void {
    const date = this.localDateKey();
    const bucket = this.botDwellDaily.get(uid);
    if (bucket && bucket.date === date) {
      bucket.ms += ms;
    } else {
      this.botDwellDaily.set(uid, { date, ms });
    }
  }

  /** 结算 sid 的官方 Bot 房计时段（若有）：累加进当日桶并删除记录。 */
  private settleBotDwell(sid: string): void {
    const record = this.botDwell.get(sid);
    if (!record) {
      return;
    }
    this.botDwell.delete(sid);
    this.addBotDwellDaily(record.uid, Date.now() - record.sinceMs);
  }

  /** 判断 sid 当前是否为某房间成员（与 recordLobbyHeartbeat/停留计时同一口径）。 */
  hasLobbyMember(sid: string): boolean {
    return this.lobbyOfSid.has(sid);
  }

  /**
   * 房间页心跳：sid 位于某房间时刷新最后心跳时间。对局进行中也照常记录
   * （扫描时会跳过对局中的房间），保证对局结束回到准备阶段后时间戳仍然新鲜。
   */
  recordLobbyHeartbeat(sid: string): void {
    if (this.hasLobbyMember(sid)) {
      this.lobbyHeartbeats.set(sid, Date.now());
    }
  }

  /**
   * 启动房间状态扫描（全局单一定时器）：每分钟检查一次非官方 AI 的官方 Bot 房
   * 停留上限，以及准备阶段超过 LOBBY_HEARTBEAT_TIMEOUT_MS 无心跳、或在房停留
   * 累计超过 LOBBY_MAX_DWELL_MS 的成员。超限者收到 room_kick 并跳回首页；
   * 对局进行中不打断，待终局回到准备阶段后检查。
   */
  startLobbyHeartbeatSweep(io: SocketIOServer): void {
    if (this.heartbeatSweepTimer) {
      return;
    }
    this.heartbeatSweepTimer = setInterval(() => {
      this.sweepInactiveLobbyMembers(io);
    }, LOBBY_HEARTBEAT_SWEEP_MS);
    this.heartbeatSweepTimer.unref();
  }

  /** 非官方 AI 每日官方 Bot 房累计达到 4 小时后，在准备阶段自动移出。 */
  private sweepBotDwellLimits(io: SocketIOServer, onlyLobbyId?: string): void {
    const now = Date.now();
    const uids = new Set([...this.botDwell.values()].map((record) => record.uid));
    const exceededUids = new Set(
      [...uids].filter((uid) => this.botDwellTotalMs(uid, now) >= BOT_DWELL_DAILY_LIMIT_MS),
    );
    for (const [sid, record] of [...this.botDwell]) {
      if (onlyLobbyId && record.gid !== onlyLobbyId) continue;
      if (!exceededUids.has(record.uid) || this.humanVerified.has(sid)) continue;
      // 对局内不踢；endGame 删除 gameInstances 后会针对该房间立即再跑一次。
      if (this.isLobbyGameRunning(record.gid)) continue;
      if (this.lobbyOfSid.get(sid) !== record.gid) {
        this.settleBotDwell(sid);
        continue;
      }
      this.kickFromLobby(io, sid, record.gid, '因今日在官方 Bot 房间累计停留已达 4 小时上限，');
    }
  }

  private sweepInactiveLobbyMembers(io: SocketIOServer): void {
    this.sweepBotDwellLimits(io);
    const now = Date.now();
    for (const [sid, lastHeartbeat] of this.lobbyHeartbeats) {
      const lobbyId = this.lobbyOfSid.get(sid);
      if (!lobbyId) {
        this.lobbyHeartbeats.delete(sid);
        this.lobbyJoinedAt.delete(sid);
        continue;
      }
      // 仅针对房间准备阶段：对局进行中的断线由 pendingRejoins 宽限期机制处理，
      // 停留超限同样等本局结束回到准备阶段后再移出。
      if (this.heartbeatExempt.has(sid) || this.isLobbyGameRunning(lobbyId)) {
        continue;
      }
      const dwellExceeded = now - (this.lobbyJoinedAt.get(sid) ?? now) > LOBBY_MAX_DWELL_MS;
      if (!dwellExceeded && now - lastHeartbeat <= LOBBY_HEARTBEAT_TIMEOUT_MS) {
        continue;
      }
      this.kickFromLobby(io, sid, lobbyId);
    }
  }

  /**
   * 心跳超时踢出：复用离开房间的清理逻辑（移出成员、广播房间/首页失效、
   * 重新检查开局条件），并向该 socket 发送 room_kick 让前端重定向到首页。
   */
  private kickFromLobby(io: SocketIOServer, sid: string, lobbyId: string, reason?: string): void {
    this.lobbyHeartbeats.delete(sid);
    this.lobbyJoinedAt.delete(sid);
    this.humanVerified.delete(sid);
    this.lobbyOfSid.delete(sid);
    const roomVal = this.getLobbyVal(lobbyId);
    io.sockets.sockets.get(sid)?.leave(`game_${roomVal}`);
    const kickSeat = this.lobbySeatName(lobbyId, sid);
    const uid = this.leaveLobby(sid, lobbyId);
    this.resetLobbyConfigIfOnlyBots(io, lobbyId);
    io.to(`sid_${sid}`).emit('room_kick', {});
    this.emitRoomUpdate(io, lobbyId);
    if (uid) {
      const kickVerb = reason ? `${reason}被移出了${kickSeat}。` : `因长时间未活跃被移出了${kickSeat}。`;
      this.sendLobbySystemMessage(io, roomVal, `${uid} ${kickVerb}`, {
        name: uid,
        verb: kickVerb,
      });
    }
    this.emitHomeRooms(io);
    this.checkReady(io, lobbyId);
  }

  generateRoomConfig(gid: string): RoomUpdatePayload {
    this.enforceLobbyConstraints(gid);

    const conf = this.lobbyConfig.get(gid);
    const players = this.lobbyPlayers.get(gid) ?? [];
    if (!conf) {
      throw new Error(`Missing lobby config for room: ${gid}`);
    }
    const normalizedMapToken = this.normalizeMapToken(conf.map_token);
    const mapMode =
      conf.map_mode === 'huaxia' && !isHuaxiaSeasonActive(new Date()) ? 'random' : conf.map_mode;
    if (normalizedMapToken !== conf.map_token) {
      conf.map_token = normalizedMapToken;
      this.lobbyConfig.set(gid, conf);
    }

    const need = this.getReq(players);
    if (this.getPlayingCount(players) < 2) {
      for (const player of players) {
        player.ready = false;
      }
    }

    const roomPlayers = players.map((player) => ({
      sid: this.md5(player.sid),
      uid: player.uid,
      team: player.team,
      ready: Boolean(player.ready && player.team !== 0),
      ...(player.serverBot === true ? { server_bot: true } : {}),
      ...(player.serverBot === true ? { server_bot_allow_team: player.serverBotAllowTeam === true } : {}),
      ...(player.serverBot === true ? { server_bot_allow_fog: player.serverBotAllowFog === true } : {}),
      ...(player.serverBot === true
        ? { server_bot_allow_multi_line: player.serverBotAllowMultiLine === true }
        : {}),
      ...(player.bot === true ? { bot: true } : {}),
      // 未通过真人客户端校验即 AI；网页在进房前发送 client_verify，避免首帧竞态。
      ...(!this.humanVerified.has(player.sid) ? { ai: true } : {}),
    }));

    const ready = players.filter((player) => player.ready && player.team !== 0).length;
    const readyCounts = this.getReadyCounts(players);

    return {
      speed: conf.speed,
      allow_team: conf.allow_team,
      fog: conf.fog === true,
      multi_line: conf.multi_line === true,
      map_token: conf.map_token,
      map_token_custom: conf.map_token_custom === true,
      map_mode: mapMode,
      map_region: normalizeMapRegion(conf.map_region),
      map_size: conf.map_size === 'large' ? 'large' : 'normal',
      in_game: this.isLobbyGameRunning(gid),
      update_queued: this.updateQueued,
      players: roomPlayers,
      ready,
      need,
      ready_counts: readyCounts,
    };
  }

  getReadyCounts(players: LobbyPlayer[]): RoomUpdatePayload['ready_counts'] {
    const participants = players.filter((player) => player.team !== 0);
    const human = participants.filter((player) => this.humanVerified.has(player.sid));
    const ai = participants.filter((player) => !this.humanVerified.has(player.sid));
    // 两人房（参战席位 ≤2）不设多数决：所有参战者都必须准备才开局；
    // 三人及以上按组内过半（ceil(n/2)）放行。
    const everyoneMustReady = participants.length <= 2;
    const count = (group: LobbyPlayer[]) => ({
      ready: group.filter((player) => player.ready).length,
      need: everyoneMustReady ? group.length : Math.ceil(group.length / 2),
      total: group.length,
    });
    return { human: count(human), ai: count(ai) };
  }

  reorderLobbyForVerification(gid: string, sid?: string): void {
    // 补验真人后与房间 AI 标记同步解除停留计时；已作为 AI 停留的部分仍计入当日桶。
    if (sid && this.humanVerified.has(sid)) {
      this.settleBotDwell(sid);
    }
    const players = this.lobbyPlayers.get(gid);
    if (!players) return;
    const sorted = [...players].sort((a, b) => {
      const tier = (p: LobbyPlayer) => (p.serverBot ? 2 : this.humanVerified.has(p.sid) ? 0 : 1);
      return tier(a) - tier(b);
    });
    if (sorted.some((player, index) => player.sid !== players[index]?.sid)) {
      players.splice(0, players.length, ...sorted);
    }
  }

  listLobbyRooms(): RoomListItem[] {
    const rooms: RoomListItem[] = [];

    for (const [room, players] of this.lobbyPlayers.entries()) {
      if (players.length === 0) {
        continue;
      }

      const playing = players.filter((player) => player.team !== 0).length;
      const ready = players.filter((player) => player.ready && player.team !== 0).length;

      rooms.push({
        room,
        host: players[0]?.uid ?? '',
        total: players.length,
        playing,
        spectators: players.length - playing,
        ready,
        need: this.getReq(players),
        ready_counts: this.getReadyCounts(players),
        running: this.isLobbyGameRunning(room),
        ...(this.lobbyConfig.get(room)?.multi_line === true ? { multi_line: true } : {}),
      });
    }

    rooms.sort((a, b) => {
      if (b.total !== a.total) {
        return b.total - a.total;
      }
      return a.room.localeCompare(b.room);
    });
    return rooms;
  }

  sendSystemMessage(
    io: SocketIOServer,
    id: string,
    scope: ChatScope,
    sender: string,
    color: number,
    text: string,
    team = false,
    fold?: ChatFoldPayload,
  ): void {
    const target = scope === 'room' ? `game_${id}` : `sid_${id}`;
    io.to(target).emit('chat_message', { sender, color, text, team, fold });
  }

  /**
   * 实时聊天框跨房间同步：把某房间的非队伍玩家聊天转发给所有其他房间，
   * 附带房间标识 room，客户端据此标注来源。
   */
  relayGlobalChat(
    io: SocketIOServer,
    fromRoomVal: string,
    roomLabel: string,
    sender: string,
    color: number,
    text: string,
  ): void {
    io.except(`game_${fromRoomVal}`).emit('chat_message', {
      sender,
      color,
      text,
      team: false,
      room: roomLabel,
    });
  }

  sendLobbySystemMessage(io: SocketIOServer, gid: string, text: string, fold?: ChatFoldPayload): void {
    this.sendSystemMessage(io, gid, 'room', '', 0, text, false, fold);
  }

  parseFloatRange(value: unknown, min: number, max: number): number {
    const parsed = Number.parseFloat(String(value));
    if (Number.isNaN(parsed) || parsed < min || parsed > max) {
      throw new Error('Invalid number range.');
    }
    return parsed;
  }

  formatConfValue(key: EditableLobbyKey, value: LobbyConfig[EditableLobbyKey]): string {
    if (key === 'allow_team') {
      return value ? '允许' : '不允许';
    }
    if (key === 'fog') {
      return value ? '开启' : '关闭';
    }
    if (key === 'multi_line') {
      return value ? '开启' : '关闭';
    }
    if (key === 'map_mode') {
      if (value === 'maze') {
        return '峡谷回廊';
      }
      if (value === 'archipelago') {
        return '群岛要塞';
      }
      if (value === 'mediterranean') {
        return '地中海';
      }
      if (value === 'huaxia') {
        return '华夏系列';
      }
      return '标准地图';
    }
    if (key === 'map_region') {
      return getHuaxiaRegion(value).name;
    }
    if (key === 'map_size') {
      return value === 'large' ? '大地图' : '标准';
    }
    return String(value);
  }

  formatConfLabel(key: EditableLobbyKey): string {
    return confStr[key];
  }

  emitRoomUpdate(io: SocketIOServer, gid: string): void {
    io.to(`game_${this.getLobbyVal(gid)}`).emit('room_update', this.generateRoomConfig(gid));
  }

  /**
   * 首页「房间列表」失效通知：无 payload，客户端收到后自行重新 fetch。
   */
  emitHomeRooms(io: SocketIOServer): void {
    io.emit('home_rooms');
  }

  async startGame(io: SocketIOServer, lobbyId: string): Promise<void> {
    // 部署更新排队期间禁止开新局（含宽限期内）。
    if (this.updateQueued) {
      return;
    }
    const conf = this.lobbyConfig.get(lobbyId);
    const players = this.lobbyPlayers.get(lobbyId);
    if (!conf || !players || players.length === 0) {
      return;
    }
    const gameId = this.getLobbyVal(lobbyId);
    if (this.gameInstances.has(gameId)) {
      return;
    }

    const playerSids = players.map((player) => player.sid);
    const playerIds = players.map((player) => this.md5(player.sid));
    const playerNames = players.map((player) => player.uid);
    const activePlayers = new Set<string>();
    for (const player of players) {
      player.ready = false;
      if (player.team !== 0) {
        this.gameUid.set(player.sid, gameId);
        activePlayers.add(player.sid);
      } else {
        this.gameUid.delete(player.sid);
      }
    }

    let autoTeamId = 1;
    const playerTeams = players.map((player) => {
      if (player.team === 0) {
        return 0;
      }
      if (conf.allow_team) {
        return player.team;
      }
      const teamId = autoTeamId;
      autoTeamId += 1;
      return teamId;
    });

    // 所有参战席位均未通过真人校验时强制 4x；观战者不计入。
    const participants = players.filter((player) => player.team !== 0);
    const allAI =
      participants.length > 0 && participants.every((player) => !this.humanVerified.has(player.sid));
    // 按引擎玩家编号保存身份，避免断线换绑或房间成员移除影响排行榜标记。
    const aiFlags = players.map((player) => !this.humanVerified.has(player.sid));

    const gameConf: GameConfig = {
      ...conf,
      speed: allAI ? 4 : conf.speed,
      map_mode: conf.map_mode === 'huaxia' && !isHuaxiaSeasonActive(new Date()) ? 'random' : conf.map_mode,
      ...this.getMapSizeConfigByPlayers(players, conf),
      player_names: playerNames,
      player_teams: playerTeams,
    };

    io.to(`game_${gameId}`).emit('starting', {});
    if (allAI) {
      this.sendLobbySystemMessage(io, gameId, '房间内全部为 AI 玩家，本局强制以 4x 速度进行。');
    }
    this.emitRoomUpdate(io, lobbyId);

    const game = await GameEngine.create(gameConf, playerSids, playerIds, gameId, {
      update: (sid, data) => {
        io.to(`sid_${sid}`).emit('update', data);
      },
      emitInitMap: (sid, data) => {
        io.to(`sid_${sid}`).emit('init_map', data);
      },
      // 实时帧排行榜装饰：按开局真人校验快照标记 ai（前端显示「[AI] 」前缀）。
      // 仅当前对局生效——回放重建不经过此回调，账号数据不受影响。
      annotateLeaderboard: (entries) => {
        for (const entry of entries) {
          entry.ai = aiFlags[entry.id - 1] === true;
        }
      },
      disciplineEvent: (event) => {
        void this.handleDisciplineEvent(event).catch(() => undefined);
      },
      chatMessage: (id, scope, sender, color, text, team = false) => {
        this.sendSystemMessage(io, id, scope, sender, color, text, team);
        if (scope === 'room' && !team && sender.length > 0) {
          const lobbyId = this.gameLobbyId.get(id);
          if (lobbyId) {
            this.relayGlobalChat(io, id, lobbyId, sender, color, text);
          }
        }
      },
      endGame: (gid, result) => {
        // 回放已在 finishGame 之前写入（saveHistory 被 await）；rating 结算完成后
        // 再广播首页排行榜失效，保证客户端重新 fetch 时拿到新数据。
        void this.applyGameResult(result).finally(() => {
          io.emit('home_leaderboard');
        });
        const lobby = this.gameLobbyId.get(gid);
        const participants = this.gamePlayers.get(gid);
        if (participants) {
          for (const sid of participants) {
            this.gameUid.delete(sid);
          }
        }
        this.gamePlayers.delete(gid);
        this.gameLobbyId.delete(gid);
        this.gameInstances.delete(gid);
        this.onGameEnded?.();

        // 对局结束：清理该局所有宽限期 timer；仍处宽限期的玩家按离开处理。
        for (const [key, pending] of this.pendingRejoins) {
          if (pending.gameId !== gid) {
            continue;
          }
          clearTimeout(pending.timer);
          this.pendingRejoins.delete(key);
          const leaveSeat = this.lobbySeatName(pending.lobbyId, pending.oldSid);
          const uid = this.leaveLobby(pending.oldSid, pending.lobbyId);
          if (uid) {
            const leaveVerb = `离开了${leaveSeat}。`;
            this.sendLobbySystemMessage(io, gid, `${uid} ${leaveVerb}`, {
              name: uid,
              verb: leaveVerb,
            });
          }
        }

        if (lobby) {
          const lobbyConf = this.lobbyConfig.get(lobby);
          if (lobbyConf) {
            // 自定义种子（issue #86）沿用到下一局，不重新随机；随机种子照旧每局重随机。
            if (lobbyConf.map_token_custom !== true) {
              lobbyConf.map_token = this.normalizeMapToken(this.randomHexToken());
            }
            this.lobbyConfig.set(lobby, lobbyConf);
          }
          const lobbyMembers = this.lobbyPlayers.get(lobby);
          if (lobbyMembers) {
            for (const member of lobbyMembers) {
              member.ready = false;
            }
          }
          // 对局结束回到准备阶段：先立即检查非官方 AI 停留上限，再广播终局房间状态。
          this.sweepBotDwellLimits(io, lobby);
          // 对局结束回到准备阶段后，若宽限期清理使房间只剩 bot，同样重置设置。
          this.resetLobbyConfigIfOnlyBots(io, lobby);
          this.emitRoomUpdate(io, lobby);
        }

        this.emitHomeRooms(io);
        io.emit('home_replays');
      },
      md5: (input: string): string => this.md5(input),
      replayStore: this.replayStore,
    });

    game.startGame();
    this.gameInstances.set(gameId, game);
    this.gameLobbyId.set(gameId, lobbyId);
    this.gamePlayers.set(gameId, activePlayers);
    this.emitHomeRooms(io);
  }

  checkReady(io: SocketIOServer, gid: string): void {
    const players = this.lobbyPlayers.get(gid);
    if (!players) {
      return;
    }
    if (this.isLobbyGameRunning(gid)) {
      this.emitRoomUpdate(io, gid);
      return;
    }
    // 部署更新排队期间禁止开新局：已就绪状态保留但不触发开局，
    // 前端经 room_update 的 update_queued 禁用开始按钮。
    if (this.updateQueued) {
      this.emitRoomUpdate(io, gid);
      return;
    }

    const readyCounts = this.getReadyCounts(players);
    if (this.getPlayingCount(players) < 2) {
      for (const player of players) {
        player.ready = false;
      }
      this.emitRoomUpdate(io, gid);
      return;
    }

    const groupsReady = [readyCounts.human, readyCounts.ai].every(
      (group) => group.total === 0 || group.ready >= group.need,
    );
    if (groupsReady) {
      // 组队模式下所有参赛者处于同一队伍时开局即终局（首 Tick 存活队伍数即为 1），
      // 拒绝开局并提示调整队伍，避免空转对局。
      const conf = this.lobbyConfig.get(gid);
      if (conf?.allow_team) {
        const teamSet = new Set(players.filter((player) => player.team !== 0).map((player) => player.team));
        if (teamSet.size < 2) {
          this.sendLobbySystemMessage(
            io,
            this.getLobbyVal(gid),
            '所有参赛者都在同一队伍，无法开始对战，请先调整队伍分配。',
          );
          this.emitRoomUpdate(io, gid);
          return;
        }
      }
      void this.startGame(io, gid);
      return;
    }

    this.emitRoomUpdate(io, gid);
  }

  checkLeave(
    io: SocketIOServer,
    sid: string,
    leaveRoom: (room: string) => void,
    username: string,
    isBot = false,
  ): void {
    this.lobbyHeartbeats.delete(sid);
    this.lobbyJoinedAt.delete(sid);
    this.humanVerified.delete(sid);
    const lobbyId = this.lobbyOfSid.get(sid);
    const gameId = this.gameUid.get(sid);

    if (gameId) {
      const game = this.gameInstances.get(gameId);
      if (game && game.markDisconnected(sid)) {
        // 掉线宽限期：截断旧指令路由，但保留房间席位与对局状态，
        // 10 秒内重连（tryRejoin）可恢复对局；超时由 expireGracePeriod 清理。
        this.gameUid.delete(sid);
        if (lobbyId) {
          this.lobbyOfSid.delete(sid);
          leaveRoom(`game_${this.getLobbyVal(lobbyId)}`);
        }
        const key = `${gameId}:${username}`;
        const existing = this.pendingRejoins.get(key);
        if (existing) {
          clearTimeout(existing.timer);
        }
        const timer = setTimeout(() => {
          this.pendingRejoins.delete(key);
          this.expireGracePeriod(io, gameId, sid);
        }, DISCONNECT_GRACE_MS);
        this.pendingRejoins.set(key, { gameId, lobbyId: lobbyId ?? '', oldSid: sid, isBot, timer });
        return;
      }
      this.gameUid.delete(sid);
      this.gamePlayers.get(gameId)?.delete(sid);
      game?.leaveGame(sid);
    }
    if (lobbyId) {
      this.gameInstances.get(this.getLobbyVal(lobbyId))?.removeSpectator(sid);
    }

    if (!lobbyId) {
      return;
    }

    this.lobbyOfSid.delete(sid);
    const roomVal = this.getLobbyVal(lobbyId);
    leaveRoom(`game_${roomVal}`);

    const leaveSeat = this.lobbySeatName(lobbyId, sid);
    const uid = this.leaveLobby(sid, lobbyId);
    this.resetLobbyConfigIfOnlyBots(io, lobbyId);
    this.emitRoomUpdate(io, lobbyId);
    if (uid) {
      const leaveVerb = `离开了${leaveSeat}。`;
      this.sendLobbySystemMessage(io, roomVal, `${uid} ${leaveVerb}`, {
        name: uid,
        verb: leaveVerb,
      });
    }
    this.emitHomeRooms(io);
    this.checkReady(io, lobbyId);
  }

  /**
   * 断线重连：对局进行中且存在同名参赛玩家（无论是否已标记断线，
   * 以覆盖顶号时新连接的 join_game_room 先于旧 socket disconnect 到达的竞态）
   * 时，把该玩家的指令路由/房间席位全部换绑到新 socket 并补发全量状态。
   *
   * 身份匹配：换绑只允许发生在同类连接之间（bot ↔ bot、人类 ↔ 人类）。
   * 服务端托管 bot 复用真实用户名，若不做此校验，同名人类打开房间页会把
   * bot 的席位换绑走（bot 从此收不到 update 而卡死），反之亦然。
   */
  tryRejoin(io: SocketIOServer, sid: string, username: string, room: string, isBot = false): boolean {
    const gameId = this.getLobbyVal(room);
    const game = this.gameInstances.get(gameId);
    if (!game) {
      return false;
    }
    const oldSid = game.findPlayerSidByName(username);
    if (!oldSid || oldSid === sid) {
      return false;
    }

    const key = `${gameId}:${username}`;
    const pending = this.pendingRejoins.get(key);

    // 旧连接仍在线时以其 socket.data.isBot 为准；已断开（宽限期中）时用
    // checkLeave 登记的身份。都不可考时按人类连接处理（保持历史行为）。
    const oldSocket = io.sockets.sockets.get(oldSid);
    const oldIsBot = oldSocket ? oldSocket.data.isBot === true : (pending?.isBot ?? false);
    if (oldIsBot !== isBot) {
      return false;
    }

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRejoins.delete(key);
    }

    this.gameUid.delete(oldSid);
    this.gameUid.set(sid, gameId);
    const participants = this.gamePlayers.get(gameId);
    if (participants) {
      participants.delete(oldSid);
      participants.add(sid);
    }
    const member = this.lobbyPlayers.get(room)?.find((player) => player.uid === username);
    if (member) {
      member.sid = sid;
    }
    this.lobbyOfSid.delete(oldSid);
    this.lobbyOfSid.set(sid, room);
    // 真人认证标记不随换绑继承：新连接需在常规事件流中重新完成校验。
    this.humanVerified.delete(oldSid);
    this.humanVerified.delete(sid);
    const lastHeartbeat = this.lobbyHeartbeats.get(oldSid);
    if (lastHeartbeat !== undefined) {
      this.lobbyHeartbeats.delete(oldSid);
      this.lobbyHeartbeats.set(sid, lastHeartbeat);
    }
    const joinedAt = this.lobbyJoinedAt.get(oldSid);
    if (joinedAt !== undefined) {
      this.lobbyJoinedAt.delete(oldSid);
      this.lobbyJoinedAt.set(sid, joinedAt);
    }
    // 非官方 AI 的官方 Bot 房计时段随换绑转移到新 sid 且保留 sinceMs
    // （对局中断线重连不丢计时段）；旧 sid 无记录则不新建。
    const botDwellRecord = this.botDwell.get(oldSid);
    if (botDwellRecord) {
      this.botDwell.delete(oldSid);
      this.botDwell.set(sid, botDwellRecord);
    }

    if (!game.rebindPlayer(oldSid, sid)) {
      return false;
    }
    this.sendLobbySystemMessage(io, gameId, `${username} 重新连接。`, {
      name: username,
      verb: '重新连接。',
    });
    return true;
  }

  /**
   * 宽限期到期：engine 侧以「挂机」投降（已重连/已出局时幂等返回 false），
   * 然后走原有完整离开清理（移出房间并广播）。
   */
  private expireGracePeriod(io: SocketIOServer, gameId: string, sid: string): void {
    const game = this.gameInstances.get(gameId);
    // 席位判定须在 expireDisconnect 之前：到期清算后该玩家不再算存活参赛者，
    // 事后再查会被误判为观战席（issue #122）。
    const lobbyIdForSeat = this.gameLobbyId.get(gameId);
    const leaveSeat = lobbyIdForSeat ? this.lobbySeatName(lobbyIdForSeat, sid) : '自定义房间';
    if (!game || !game.expireDisconnect(sid)) {
      return;
    }
    this.gamePlayers.get(gameId)?.delete(sid);
    const lobbyId = this.gameLobbyId.get(gameId);
    if (!lobbyId) {
      return;
    }
    const uid = this.leaveLobby(sid, lobbyId);
    // 宽限期在对局进行中到期时 resetLobbyConfigIfOnlyBots 内部会按
    // isLobbyGameRunning 跳过，对局结束后再由 endGame 路径判定。
    this.resetLobbyConfigIfOnlyBots(io, lobbyId);
    this.emitRoomUpdate(io, lobbyId);
    if (uid) {
      const leaveVerb = `离开了${leaveSeat}。`;
      this.sendLobbySystemMessage(io, gameId, `${uid} ${leaveVerb}`, {
        name: uid,
        verb: leaveVerb,
      });
    }
    this.emitHomeRooms(io);
    this.checkReady(io, lobbyId);
  }

  returnToRoom(io: SocketIOServer, sid: string): boolean {
    const lobbyId = this.lobbyOfSid.get(sid);
    if (lobbyId) {
      this.gameInstances.get(this.getLobbyVal(lobbyId))?.removeSpectator(sid);
    }

    const gameId = this.gameUid.get(sid);
    if (!gameId) {
      if (lobbyId) {
        this.emitRoomUpdate(io, lobbyId);
        return true;
      }
      return false;
    }
    this.gameUid.delete(sid);
    this.gamePlayers.get(gameId)?.delete(sid);
    this.gameInstances.get(gameId)?.leaveGame(sid);
    if (lobbyId) {
      this.emitRoomUpdate(io, lobbyId);
    }
    return true;
  }

  /**
   * 机器人房间只剩 bot 时自动重置房间设置：
   * 准备阶段（对局未开始）的房间人员变化后调用。剩余成员全部带 bot 标记
   * （含观战席——观战的人类仍算人类占用，不触发重置）且至少有一人时，
   * 把可编辑设置整体重置为新建房间的默认值（复用 defaultLobbyConfig，
   * 与建房同一默认值来源，含重新随机地图种子）；bot 留在房内继续待命。
   * 普通房间人走光后成员列表为空，不触发本逻辑（下次进房时 joinLobby
   * 本就会按新房间重建默认配置）；对局进行中由调用方保证不触发。
   */
  private resetLobbyConfigIfOnlyBots(io: SocketIOServer, lobbyId: string): void {
    if (this.isLobbyGameRunning(lobbyId)) {
      return;
    }
    const players = this.lobbyPlayers.get(lobbyId);
    if (!players || players.length === 0) {
      return;
    }
    if (players.some((player) => player.bot !== true)) {
      return;
    }
    this.lobbyConfig.set(lobbyId, this.defaultLobbyConfig());
    this.sendLobbySystemMessage(io, this.getLobbyVal(lobbyId), '房间内只剩机器人，房间设置已重置为默认值。');
  }

  private defaultLobbyConfig(): LobbyConfig {
    return {
      width_ratio: FIXED_WIDTH_RATIO,
      height_ratio: FIXED_HEIGHT_RATIO,
      city_ratio: FIXED_CITY_RATIO,
      mountain_ratio: FIXED_MOUNTAIN_RATIO,
      swamp_ratio: FIXED_SWAMP_RATIO,
      speed: 1,
      allow_team: false,
      fog: false,
      multi_line: false,
      map_token: this.normalizeMapToken(this.randomHexToken()),
      map_token_custom: false,
      map_mode: 'random',
      map_region: DEFAULT_MAP_REGION,
      map_size: 'normal',
    };
  }

  private enforceLobbyConstraints(gid: string): void {
    const conf = this.lobbyConfig.get(gid);
    const players = this.lobbyPlayers.get(gid);
    if (!conf || !players) {
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
      if (!conf.allow_team) {
        player.team = 1;
      }
      playingCount += 1;
    }
  }

  /**
   * 组队房间中为新进房成员挑选默认队伍：人数最少的非空队伍，全空时取 1 队。
   * 不做 bot/人类分池——队伍归属完全由成员自行决定（change_team）。
   */
  private pickLeastPopulatedTeam(players: LobbyPlayer[]): number {
    const teamCount = Array.from({ length: MAX_TEAMS + 1 }, () => 0);
    for (const player of players) {
      if (player.team > 0 && player.team <= MAX_TEAMS) {
        teamCount[player.team] += 1;
      }
    }
    let bestTeam = 0;
    let minCount = Number.POSITIVE_INFINITY;
    for (let team = 1; team <= MAX_TEAMS; team += 1) {
      if (teamCount[team] > 0 && teamCount[team] < minCount) {
        minCount = teamCount[team];
        bestTeam = team;
      }
    }
    return bestTeam === 0 ? 1 : bestTeam;
  }

  private getPlayingCount(players: LobbyPlayer[]): number {
    return players.filter((player) => player.team !== 0).length;
  }

  private getMapSizeRatioByPlayers(players: LobbyPlayer[], mapRegion: LobbyConfig['map_region']): number {
    return resolveMapSizeRatioByPlayersAndRegion(this.getPlayingCount(players), mapRegion);
  }

  /**
   * 开局时的实际地图尺寸：按人数取基础比例，台湾省地图略微放大，房间开启大地图时再 ×2
   * （边长约 2 倍、面积约 4 倍）。
   */
  private getMapSizeConfigByPlayers(
    players: LobbyPlayer[],
    conf: LobbyConfig,
  ): Pick<LobbyConfig, 'width_ratio' | 'height_ratio'> {
    const ratio =
      this.getMapSizeRatioByPlayers(players, conf.map_region) * (conf.map_size === 'large' ? 2 : 1);
    return {
      width_ratio: ratio,
      height_ratio: ratio,
    };
  }

  /**
   * 统一 Rating：多人 ELO 推广。队伍名次取队内最好名次在队伍间的位次
   * （不能直接用成员榜名次代入得分公式：score 的值域是 1..队伍数，
   * 而成员名次值域是 1..人数，2v2 输队最好名次为 3 时 score 会被压到
   * -1，输方扣分超过 K 且输赢不对称），
   * 队伍 Rating 按「人数³ × 成员战力之和」折算回 ELO
   * （400 * log10(n³ · Σ 10^(r/400))）：本游戏中人数优势是压倒性的
   * （等分时 1v2 期望胜率约 1/17、1v3 约 1/82），立方加权让队伍分
   * 反映这一点，避免「1 个高分打一堆中分」被视为均势局；
   * 单人队退化为成员自身分。得分按队伍位次线性分布，K = 24。
   */
  private async applyGameResult(result: GameResultEntry[]): Promise<void> {
    const uniqueResult = [
      ...new Map(result.map((entry) => [entry.uid.trim().toLowerCase(), entry])).values(),
    ].sort((a, b) => a.rank - b.rank);
    await this.userStore
      .applyPointsUpdates(
        uniqueResult.map((entry, index) => ({
          username: entry.uid,
          points: getGamePoints(index + 1, uniqueResult.length),
        })),
      )
      .catch(() => undefined);

    if (result.length < 2) {
      return;
    }

    const teamRank = new Map<number, number>();
    for (const entry of result) {
      const prev = teamRank.get(entry.team);
      if (prev === undefined || entry.rank < prev) {
        teamRank.set(entry.team, entry.rank);
      }
    }
    const teams = [...teamRank.keys()];
    if (teams.length < 2) {
      return;
    }

    // 队伍位次：按队内最好名次在队伍间排序为 1..teams.length，
    // 保证 score = (teams - place) / (teams - 1) 落在 [0, 1]。
    const teamPlace = new Map<number, number>();
    [...teams]
      .sort((a, b) => (teamRank.get(a) ?? 0) - (teamRank.get(b) ?? 0))
      .forEach((team, index) => teamPlace.set(team, index + 1));

    const teamRating = new Map<number, number>();
    for (const team of teams) {
      const members = result.filter((entry) => entry.team === team);
      const strength =
        members.length ** 3 *
        members.reduce((sum, entry) => sum + 10 ** (this.userStore.getRating(entry.uid).rating / 400), 0);
      teamRating.set(team, 400 * Math.log10(strength));
    }

    const updates: Array<{ username: string; delta: number }> = [];
    for (const team of teams) {
      const rank = teamPlace.get(team) ?? teams.length;
      const score = (teams.length - rank) / (teams.length - 1);
      let expected = 0;
      for (const other of teams) {
        if (other === team) {
          continue;
        }
        expected +=
          1 / (1 + 10 ** (((teamRating.get(other) ?? 1200) - (teamRating.get(team) ?? 1200)) / 400));
      }
      expected /= teams.length - 1;
      const delta = RATING_K * (score - expected);
      for (const entry of result) {
        if (entry.team === team) {
          updates.push({ username: entry.uid, delta });
        }
      }
    }

    await this.userStore.applyRatingUpdates(updates).catch(() => undefined);
  }

  private getReq(players: LobbyPlayer[]): number {
    const playingCount = this.getPlayingCount(players);
    if (playingCount < 2) {
      return 0;
    }
    // Legacy clients use need > 1 to decide whether to ready up.
    // Actual start eligibility is exclusively determined by getReadyCounts.
    return Math.floor(playingCount / 2) + 1;
  }
}

export { LobbyService };
export type { EditableLobbyKey };
