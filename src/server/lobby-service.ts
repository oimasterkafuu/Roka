import { createHash, randomBytes } from 'node:crypto';
import { Server as SocketIOServer } from 'socket.io';
import { UserStore } from '../auth-store';
import { GameEngine } from '../game-engine';
import { DISCONNECT_GRACE_MS } from '../game-engine/constants';
import { resolveMapSizeRatioByPlayers } from '../map/map-size';
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
} from '../types';

type EditableLobbyKey = 'speed' | 'allow_team' | 'map_mode' | 'map_token';

const FIXED_WIDTH_RATIO = 0.5;
const FIXED_HEIGHT_RATIO = 0.5;
const FIXED_CITY_RATIO = 0.5;
const FIXED_MOUNTAIN_RATIO = 0.5;
const FIXED_SWAMP_RATIO = 0.5;
const MAP_TOKEN_MAX_LENGTH = 32;
const RATING_K = 24;
/** 房间准备阶段的心跳超时：超过 600 秒无心跳的成员被自动移出房间。 */
const LOBBY_HEARTBEAT_TIMEOUT_MS = 600_000;
/** 心跳扫描周期：每分钟检查一次全部房间成员的最后心跳时间。 */
const LOBBY_HEARTBEAT_SWEEP_MS = 60_000;

const confStr: Record<EditableLobbyKey, string> = {
  speed: '游戏速度',
  allow_team: '允许组队',
  map_mode: '地图类型',
  map_token: '地图随机种子',
};

/**
 * 掉线宽限期中的待重连记录，键为 `${gameId}:${username}`。
 * timer 到期仍未重连则以「挂机」投降并执行完整离开清理。
 */
interface PendingRejoin {
  gameId: string;
  lobbyId: string;
  oldSid: string;
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
  /** 豁免心跳踢出的 sid（ROKA_BOT_TOKENS 鉴权的 bot 连接，由 server.ts 维护）。 */
  readonly heartbeatExempt = new Set<string>();
  private heartbeatSweepTimer?: NodeJS.Timeout;

  /** 对局全部结束时触发（例如让推迟中的自动更新继续执行）。 */
  onGameEnded?: () => void;

  constructor(
    private readonly replayStore: ReplayStore,
    private readonly userStore: UserStore,
  ) {}

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

  hasActiveGames(): boolean {
    return this.gameInstances.size > 0;
  }

  getLobbyVal(gid: string): string {
    let value = this.lobbyRoomValue.get(gid);
    if (!value) {
      value = this.md5(`${gid}:${Date.now()}:${Math.random()}`);
      this.lobbyRoomValue.set(gid, value);
    }
    return value;
  }

  joinLobby(sid: string, uid: string, gid: string, options?: { serverBot?: boolean }): void {
    this.lobbyOfSid.set(sid, gid);
    // 进房本身即是「标签页开启」的证明，作为心跳基线。
    this.lobbyHeartbeats.set(sid, Date.now());
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
      return;
    }

    const playingCount = players.filter((player) => player.team !== 0).length;
    let targetTeam = 0;

    if (playingCount < MAX_TEAMS) {
      if (!conf.allow_team) {
        targetTeam = 1;
      } else {
        const teamCount = Array.from({ length: MAX_TEAMS + 1 }, () => 0);
        for (const player of players) {
          teamCount[player.team] += 1;
        }

        let minCount = Number.POSITIVE_INFINITY;
        targetTeam = 1;
        for (let i = 1; i <= MAX_TEAMS; i += 1) {
          if (teamCount[i] < minCount) {
            minCount = teamCount[i];
            targetTeam = i;
          }
        }
      }
    }

    const player: LobbyPlayer = { sid, uid, team: targetTeam, ready: false };
    if (options?.serverBot) {
      // 服务端托管 bot 永远排在普通成员之后：房主（players[0]）保留给
      // 人类用户或第三方 bot。bot 单独在房时暂居首位，任何普通成员进房即接任。
      player.serverBot = true;
      players.push(player);
      return;
    }
    // 普通成员插入到首个服务端托管 bot 之前（无 bot 时等价于末尾追加，保持 FIFO）。
    let insertIndex = 0;
    while (insertIndex < players.length && players[insertIndex].serverBot !== true) {
      insertIndex += 1;
    }
    players.splice(insertIndex, 0, player);
  }

  leaveLobby(sid: string, gid: string): string {
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

  /**
   * 房间页心跳：sid 位于某房间时刷新最后心跳时间。对局进行中也照常记录
   * （扫描时会跳过对局中的房间），保证对局结束回到准备阶段后时间戳仍然新鲜。
   */
  recordLobbyHeartbeat(sid: string): void {
    if (this.lobbyOfSid.has(sid)) {
      this.lobbyHeartbeats.set(sid, Date.now());
    }
  }

  /**
   * 启动房间心跳扫描（全局单一定时器）：每分钟检查一次，准备阶段超过
   * LOBBY_HEARTBEAT_TIMEOUT_MS 无心跳的成员被自动移出房间并收到 room_kick
   * 事件（前端据此跳转首页）；heartbeatExempt 中的 bot 连接不受影响。
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

  private sweepInactiveLobbyMembers(io: SocketIOServer): void {
    const now = Date.now();
    for (const [sid, lastHeartbeat] of this.lobbyHeartbeats) {
      const lobbyId = this.lobbyOfSid.get(sid);
      if (!lobbyId) {
        this.lobbyHeartbeats.delete(sid);
        continue;
      }
      // 仅针对房间准备阶段：对局进行中的断线由 pendingRejoins 宽限期机制处理。
      if (this.heartbeatExempt.has(sid) || this.isLobbyGameRunning(lobbyId)) {
        continue;
      }
      if (now - lastHeartbeat <= LOBBY_HEARTBEAT_TIMEOUT_MS) {
        continue;
      }
      this.kickFromLobby(io, sid, lobbyId);
    }
  }

  /**
   * 心跳超时踢出：复用离开房间的清理逻辑（移出成员、广播房间/首页失效、
   * 重新检查开局条件），并向该 socket 发送 room_kick 让前端重定向到首页。
   */
  private kickFromLobby(io: SocketIOServer, sid: string, lobbyId: string): void {
    this.lobbyHeartbeats.delete(sid);
    this.lobbyOfSid.delete(sid);
    const roomVal = this.getLobbyVal(lobbyId);
    io.sockets.sockets.get(sid)?.leave(`game_${roomVal}`);
    const uid = this.leaveLobby(sid, lobbyId);
    io.to(`sid_${sid}`).emit('room_kick', {});
    this.emitRoomUpdate(io, lobbyId);
    if (uid) {
      this.sendLobbySystemMessage(io, roomVal, `${uid} 因长时间未活跃被移出了自定义房间。`);
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
    if (normalizedMapToken !== conf.map_token) {
      conf.map_token = normalizedMapToken;
      this.lobbyConfig.set(gid, conf);
    }

    const need = this.getReq(players);
    if (need <= 1) {
      for (const player of players) {
        player.ready = false;
      }
    }

    const roomPlayers = players.map((player) => ({
      sid: this.md5(player.sid),
      uid: player.uid,
      team: player.team,
      ready: Boolean(player.ready && player.team !== 0),
    }));

    const ready = players.filter((player) => player.ready && player.team !== 0).length;

    return {
      speed: conf.speed,
      allow_team: conf.allow_team,
      map_token: conf.map_token,
      map_mode: conf.map_mode,
      in_game: this.isLobbyGameRunning(gid),
      players: roomPlayers,
      ready,
      need,
    };
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
  ): void {
    const target = scope === 'room' ? `game_${id}` : `sid_${id}`;
    io.to(target).emit('chat_message', { sender, color, text, team });
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

  sendLobbySystemMessage(io: SocketIOServer, gid: string, text: string): void {
    this.sendSystemMessage(io, gid, 'room', '', 0, text);
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
      return '标准地图';
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

    const gameConf: GameConfig = {
      ...conf,
      ...this.getMapSizeConfigByPlayers(players),
      player_names: playerNames,
      player_teams: playerTeams,
    };

    io.to(`game_${gameId}`).emit('starting', {});
    this.emitRoomUpdate(io, lobbyId);

    const game = await GameEngine.create(gameConf, playerSids, playerIds, gameId, {
      update: (sid, data) => {
        io.to(`sid_${sid}`).emit('update', data);
      },
      emitInitMap: (sid, data) => {
        io.to(`sid_${sid}`).emit('init_map', data);
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
          const uid = this.leaveLobby(pending.oldSid, pending.lobbyId);
          if (uid) {
            this.sendLobbySystemMessage(io, gid, `${uid} 离开了自定义房间。`);
          }
        }

        if (lobby) {
          const lobbyConf = this.lobbyConfig.get(lobby);
          if (lobbyConf) {
            lobbyConf.map_token = this.normalizeMapToken(this.randomHexToken());
            this.lobbyConfig.set(lobby, lobbyConf);
          }
          const lobbyMembers = this.lobbyPlayers.get(lobby);
          if (lobbyMembers) {
            for (const member of lobbyMembers) {
              member.ready = false;
            }
          }
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

    const ready = players.filter((player) => player.ready && player.team !== 0).length;
    const required = this.getReq(players);
    if (required <= 1) {
      for (const player of players) {
        player.ready = false;
      }
      this.emitRoomUpdate(io, gid);
      return;
    }

    if (required > 0 && ready >= required) {
      void this.startGame(io, gid);
      return;
    }

    this.emitRoomUpdate(io, gid);
  }

  checkLeave(io: SocketIOServer, sid: string, leaveRoom: (room: string) => void, username: string): void {
    this.lobbyHeartbeats.delete(sid);
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
        this.pendingRejoins.set(key, { gameId, lobbyId: lobbyId ?? '', oldSid: sid, timer });
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

    const uid = this.leaveLobby(sid, lobbyId);
    this.emitRoomUpdate(io, lobbyId);
    if (uid) {
      this.sendLobbySystemMessage(io, roomVal, `${uid} 离开了自定义房间。`);
    }
    this.emitHomeRooms(io);
    this.checkReady(io, lobbyId);
  }

  /**
   * 断线重连：对局进行中且存在同名参赛玩家（无论是否已标记断线，
   * 以覆盖顶号时新连接的 join_game_room 先于旧 socket disconnect 到达的竞态）
   * 时，把该玩家的指令路由/房间席位全部换绑到新 socket 并补发全量状态。
   */
  tryRejoin(io: SocketIOServer, sid: string, username: string, room: string): boolean {
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
    const lastHeartbeat = this.lobbyHeartbeats.get(oldSid);
    if (lastHeartbeat !== undefined) {
      this.lobbyHeartbeats.delete(oldSid);
      this.lobbyHeartbeats.set(sid, lastHeartbeat);
    }

    if (!game.rebindPlayer(oldSid, sid)) {
      return false;
    }
    this.sendLobbySystemMessage(io, gameId, `${username} 重新连接。`);
    return true;
  }

  /**
   * 宽限期到期：engine 侧以「挂机」投降（已重连/已出局时幂等返回 false），
   * 然后走原有完整离开清理（移出房间并广播）。
   */
  private expireGracePeriod(io: SocketIOServer, gameId: string, sid: string): void {
    const game = this.gameInstances.get(gameId);
    if (!game || !game.expireDisconnect(sid)) {
      return;
    }
    this.gamePlayers.get(gameId)?.delete(sid);
    const lobbyId = this.gameLobbyId.get(gameId);
    if (!lobbyId) {
      return;
    }
    const uid = this.leaveLobby(sid, lobbyId);
    this.emitRoomUpdate(io, lobbyId);
    if (uid) {
      this.sendLobbySystemMessage(io, gameId, `${uid} 离开了自定义房间。`);
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

  private defaultLobbyConfig(): LobbyConfig {
    return {
      width_ratio: FIXED_WIDTH_RATIO,
      height_ratio: FIXED_HEIGHT_RATIO,
      city_ratio: FIXED_CITY_RATIO,
      mountain_ratio: FIXED_MOUNTAIN_RATIO,
      swamp_ratio: FIXED_SWAMP_RATIO,
      speed: 1,
      allow_team: false,
      map_token: this.normalizeMapToken(this.randomHexToken()),
      map_mode: 'random',
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

  private getReqReady(x: number): number {
    // 非观战用户中「我准备好了」超过向下取整的 1/2 即自动开始。
    return Math.floor(x / 2) + 1;
  }

  private getPlayingCount(players: LobbyPlayer[]): number {
    return players.filter((player) => player.team !== 0).length;
  }

  private getMapSizeRatioByPlayers(players: LobbyPlayer[]): number {
    return resolveMapSizeRatioByPlayers(this.getPlayingCount(players));
  }

  private getMapSizeConfigByPlayers(
    players: LobbyPlayer[],
  ): Pick<LobbyConfig, 'width_ratio' | 'height_ratio'> {
    const ratio = this.getMapSizeRatioByPlayers(players);
    return {
      width_ratio: ratio,
      height_ratio: ratio,
    };
  }

  /**
   * 统一 Rating：多人 ELO 推广。队伍名次取队内最好名次，
   * 队伍 Rating 取队内平均；得分按名次线性分布，K = 24。
   */
  private async applyGameResult(result: GameResultEntry[]): Promise<void> {
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

    const teamRating = new Map<number, number>();
    for (const team of teams) {
      const members = result.filter((entry) => entry.team === team);
      const avg =
        members.reduce((sum, entry) => sum + this.userStore.getRating(entry.uid).rating, 0) / members.length;
      teamRating.set(team, avg);
    }

    const updates: Array<{ username: string; delta: number }> = [];
    for (const team of teams) {
      const rank = teamRank.get(team) ?? teams.length;
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
    return this.getReqReady(playingCount);
  }
}

export { LobbyService };
export type { EditableLobbyKey };
