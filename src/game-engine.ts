import { randomInt } from 'node:crypto';
import {
  GeneralPos,
  Grid,
  MapMode,
  SeededRandom,
  Tile,
  normalizeMapToken,
  resolveMapSeed,
  resolveSeededTerrainRatio,
} from './map/map-core';
import { generateArchipelagoMap } from './map/archipelago-map-generator';
import { generateMediterraneanMap } from './map/mediterranean-map-generator';
import { generateHuaxiaMap } from './map/huaxia-map-generator';
import { DEFAULT_MAP_REGION, normalizeMapRegion } from './map/huaxia-regions';
import { generateMazeMap } from './map/maze-map-generator';
import { generateRandomMap } from './map/random-map-generator';
import { ReplayStore } from './replay-store';
import {
  AFK_MIN_MS,
  AFK_MIN_TURNS,
  CROWN_TRANSFER_REQUEST_TTL_MS,
  ISOLATED_DECAY_RATIO,
  ISOLATED_GRACE_TICKS,
  LEFT_GAME,
} from './game-engine/constants';
import { selectMazeGenerals, selectRandomGenerals } from './game-engine/general-selection';
import { buildFinalRank, buildFinalRankTeams, buildLeaderboard } from './game-engine/leaderboard';
import { buildFullVisionArrays } from './game-engine/map-encoding';
import { buildFoggedVisionArrays, computeTeamVisibility } from './game-engine/fog-vision';
import { buildReplayPatch, getDiff } from './game-engine/replay-helpers';
import { buildScheduledReplayActions } from './game-engine/replay-scheduling';
import { buildReplayPlayerOps, buildTurnMoves } from './game-engine/replay-turns';
import { applyTickGrowth } from './game-engine/tick-growth';
import {
  ChatScope,
  GameConfig,
  GameResultEntry,
  MapRegion,
  MoveMode,
  QueuedOpKind,
  ReplayActionData,
  ReplayData,
  ReplayPatch,
  ReplayMeta,
  UpdatePayload,
} from './types';

type Move = [number, number, number, number, MoveMode];

/**
 * 玩家队列操作：'m' 推兵 / 'b' 建造指挥所（X）/ 'c' 升级主城（C）。
 */
type QueuedOp =
  | { kind: 'm'; x: number; y: number; dx: number; dy: number; mode: MoveMode }
  | { kind: 'b' | 'c'; x: number; y: number };

/**
 * 建造指挥所 / 升级主城的兵力消耗。
 */
const BUILD_COST = 50;

export type GameDisciplineCause = 'manual_surrender' | 'leave' | 'afk' | 'disconnect_timeout';

export interface GameDisciplineEvent {
  gameId: string;
  username: string;
  cause: GameDisciplineCause;
  turn: number;
  elapsedMs: number;
  occurredAt: number;
  /** 本局实际玩家总数（参赛者席位数，不含观战者）。 */
  playerCount: number;
}

interface GameCallbacks {
  update: (sid: string, data: UpdatePayload) => void;
  emitInitMap: (
    sid: string,
    data: { n: number; m: number; player_ids: string[]; general: GeneralPos },
  ) => void;
  chatMessage: (
    id: string,
    scope: ChatScope,
    sender: string,
    color: number,
    text: string,
    team?: boolean,
  ) => void;
  endGame: (gid: string, result: GameResultEntry[]) => void;
  disciplineEvent?: (event: GameDisciplineEvent) => void;
  /** 主城转让请求（issue #81）：转发给主城当前拥有者等待确认。 */
  crownTransferRequest?: (sid: string, data: { x: number; y: number; from: string }) => void;
  md5: (input: string) => string;
  replayStore: ReplayStore;
}

const clampMapSizeRatio = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  // 上限需容纳大地图：人数比例峰值约 1.24，大地图 ×2 后约 2.5。
  return Math.max(0.2, Math.min(3, value));
};

const resolveRuntimeMapSizeRatio = (ratio: number, mapSizeVersion: 1 | 2): number => {
  if (mapSizeVersion === 1) {
    return ratio / 2 + 0.5;
  }
  return ratio;
};

const MOVE_DX = [-1, 1, 0, 0];
const MOVE_DY = [0, 0, -1, 1];

export class GameEngine {
  private readonly update: (sid: string, data: UpdatePayload) => void;

  private readonly emitInitMap: GameCallbacks['emitInitMap'];

  private readonly chatMessage: GameCallbacks['chatMessage'];

  private readonly endGame: GameCallbacks['endGame'];

  private readonly disciplineEvent: NonNullable<GameCallbacks['disciplineEvent']>;

  private readonly crownTransferRequest: NonNullable<GameCallbacks['crownTransferRequest']>;

  private readonly md5: GameCallbacks['md5'];

  private readonly replayStore: ReplayStore;

  readonly names: string[];

  private readonly playerSids: string[];

  private readonly playerIds: string[];

  private readonly playerSidToIndex: Map<string, number>;

  private readonly team: number[];

  private readonly widthRatio: number;

  private readonly heightRatio: number;

  private readonly cityRatio: number;

  private readonly mountainRatio: number;

  private readonly swampRatio: number;

  private readonly speed: number;

  private readonly mapToken: string;

  private readonly mapSeed: string;

  private readonly mapMode: MapMode;

  private readonly mapRegion: MapRegion;

  /**
   * 迷雾远征开关（房间设置）：开启后存活参赛者只收到己方队伍视野内的
   * 真实归属/兵力；视野外格子只保留山脉（201）与沼泽（204），其余抹成
   * 空地（200）；观战者、出局者与回放始终全视野。
   */
  private readonly fogEnabled: boolean;

  private readonly rng: SeededRandom;

  private readonly replayMeta: ReplayMeta;

  private readonly gid: string;

  private readonly pstat: number[];

  private readonly pmove: QueuedOp[][];

  private readonly lstMove: Array<QueuedOp | null>;

  /**
   * 本 Tick 每名玩家被执行操作前丢弃的失效队首操作数（用于客户端精确同步队列显示）。
   */
  private readonly lstSkip: number[];

  private readonly watching: boolean[];

  private readonly spec: boolean[];

  private readonly gridTypeLast: number[][];

  private readonly armyCntLast: number[][];

  private readonly isolatedLast: number[][];

  /** 迷雾帧 diff 基线（仅迷雾对局使用），与 gridTypeLast 平行按玩家维护。 */
  private readonly fogLast: number[][];

  private readonly deadOrder: number[];

  private readonly replayTurnMoves: Array<Array<QueuedOp | null>>;

  private readonly replayTurnSurrenders: Array<Set<number>>;

  /** 每名玩家（接收方）每回合生效的主城转让：turn → 被转让的主城格坐标（issue #81）。 */
  private readonly replayTurnTransfers: Array<Map<number, { x: number; y: number }>>;

  /**
   * 待确认的主城转让请求（issue #81）：键为主城当前拥有者下标，
   * 每名拥有者同时最多一个待处理请求（防刷），超时自动作废。
   */
  private readonly crownTransferPending: Map<
    number,
    { from: number; x: number; y: number; timer: NodeJS.Timeout }
  >;

  private readonly externalSpectatorSids: Set<string>;

  /**
   * 观战视角偏好：sid → 队伍编号（仅迷雾对局生效；缺省/0 = 全图全视野）。
   * 覆盖中途进房的外部观战者与观战席/已战败玩家；存活参赛者被 setSpectatorView 拒绝。
   */
  private readonly spectatorViewTeams: Map<string, number>;

  private readonly afkLastMoveTurn: number[];

  private readonly afkLastMoveAt: number[];

  /**
   * 每名玩家 socket 断开的时间戳（null = 在线）。宽限期内不投降，
   * 重连时由 rebindPlayer 清回 null，超时由 expireDisconnect 投降。
   */
  private readonly disconnectedAt: Array<number | null>;

  private readonly enableAfkSurrender: boolean;

  private readonly startAt: number;

  private owner: Grid<number> = [];

  private armyCnt: Grid<number> = [];

  private gridType: Grid<Tile> = [];

  private isolated: Grid<boolean> = [];

  /**
   * 每格连续处于孤军状态的 Tick 数（0 = 非孤军）。用于断链宽限期与每回合衰减节奏。
   */
  private isolatedAge: Grid<number> = [];

  private st: Grid<boolean> = [];

  private generals: GeneralPos[] = [];

  private n = 0;

  private m = 0;

  private turn = 0;

  private deadCount = 0;

  private recentKills: Record<string, string> = {};

  private tickTimer: NodeJS.Timeout | null = null;

  /** 终局幂等标记：正常终局与部署更新清算（forceFinish）共用，防止重复结算。 */
  private finished = false;

  private lastTickAt = 0;

  private constructor(
    gameConf: GameConfig,
    playerSids: string[],
    playerIds: string[],
    gid: string,
    callbacks: GameCallbacks,
  ) {
    this.startAt = Date.now();
    this.update = callbacks.update;
    this.emitInitMap = callbacks.emitInitMap;
    this.chatMessage = callbacks.chatMessage;
    this.endGame = callbacks.endGame;
    this.disciplineEvent = callbacks.disciplineEvent ?? (() => undefined);
    this.crownTransferRequest = callbacks.crownTransferRequest ?? (() => undefined);
    this.md5 = callbacks.md5;
    this.replayStore = callbacks.replayStore;

    this.playerSids = [...playerSids];
    this.playerIds = [...playerIds];
    this.playerSidToIndex = new Map(playerSids.map((sid, idx) => [sid, idx]));

    this.speed = gameConf.speed;
    this.names = [...gameConf.player_names];
    this.team = [...gameConf.player_teams];

    this.mapToken = normalizeMapToken(gameConf.map_token) || 'default';
    this.mapMode = gameConf.map_mode;
    this.mapRegion = normalizeMapRegion(gameConf.map_region ?? DEFAULT_MAP_REGION);
    this.fogEnabled = gameConf.fog === true;
    this.mapSeed = resolveMapSeed(
      this.mapMode,
      this.mapMode === 'huaxia' ? `${this.mapRegion}:${this.mapToken}` : this.mapToken,
    );
    this.rng = new SeededRandom(this.mapSeed);
    const seededCityRatio = resolveSeededTerrainRatio(this.mapSeed, 'city_ratio');
    const seededMountainRatio = resolveSeededTerrainRatio(this.mapSeed, 'mountain_ratio');
    const mapSizeVersion: 1 | 2 = gameConf.map_size_version ?? (gid === '__replay_build__' ? 1 : 2);

    this.widthRatio = clampMapSizeRatio(resolveRuntimeMapSizeRatio(gameConf.width_ratio, mapSizeVersion));
    this.heightRatio = clampMapSizeRatio(resolveRuntimeMapSizeRatio(gameConf.height_ratio, mapSizeVersion));
    this.cityRatio = seededCityRatio;
    this.mountainRatio = seededMountainRatio;
    this.swampRatio = gameConf.swamp_ratio;
    this.replayMeta = {
      width_ratio: gameConf.width_ratio,
      height_ratio: gameConf.height_ratio,
      city_ratio: seededCityRatio,
      mountain_ratio: seededMountainRatio,
      swamp_ratio: gameConf.swamp_ratio,
      speed: gameConf.speed,
      allow_team: gameConf.allow_team,
      fog: gameConf.fog === true,
      map_token: this.mapToken,
      map_mode: gameConf.map_mode,
      map_region: this.mapRegion,
      player_names: [...gameConf.player_names],
      player_teams: [...gameConf.player_teams],
      map_size_version: mapSizeVersion,
      map_size: gameConf.map_size === 'large' ? 'large' : 'normal',
    };

    const pcnt = playerSids.length;
    this.pstat = Array.from({ length: pcnt }, () => 0);
    this.pmove = Array.from({ length: pcnt }, () => []);
    this.lstMove = Array.from({ length: pcnt }, () => null);
    this.lstSkip = Array.from({ length: pcnt }, () => 0);
    this.watching = Array.from({ length: pcnt }, () => true);
    this.spec = Array.from({ length: pcnt }, () => false);
    this.gridTypeLast = Array.from({ length: pcnt }, () => []);
    this.armyCntLast = Array.from({ length: pcnt }, () => []);
    this.isolatedLast = Array.from({ length: pcnt }, () => []);
    this.fogLast = Array.from({ length: pcnt }, () => []);
    this.deadOrder = Array.from({ length: pcnt }, () => 0);
    this.replayTurnMoves = [];
    this.replayTurnSurrenders = Array.from({ length: pcnt }, () => new Set<number>());
    this.replayTurnTransfers = Array.from(
      { length: pcnt },
      () => new Map<number, { x: number; y: number }>(),
    );
    this.crownTransferPending = new Map();
    this.externalSpectatorSids = new Set<string>();
    this.spectatorViewTeams = new Map<string, number>();
    this.afkLastMoveTurn = Array.from({ length: pcnt }, () => 0);
    this.afkLastMoveAt = Array.from({ length: pcnt }, () => this.startAt);
    this.disconnectedAt = Array.from({ length: pcnt }, () => null);
    this.enableAfkSurrender = gid !== '__replay_build__';

    this.gid = gid;
  }

  static async create(
    gameConf: GameConfig,
    playerSids: string[],
    playerIds: string[],
    gid: string,
    callbacks: GameCallbacks,
  ): Promise<GameEngine> {
    const engine = new GameEngine(gameConf, playerSids, playerIds, gid, callbacks);
    await engine.initializeMap();
    engine.selectGenerals();

    for (let i = 0; i < playerSids.length; i += 1) {
      callbacks.emitInitMap(playerSids[i], {
        n: engine.n,
        m: engine.m,
        player_ids: [...playerIds],
        general: engine.generals[i],
      });
    }

    return engine;
  }

  static async buildReplayBaseMap(meta: ReplayMeta): Promise<{
    n: number;
    m: number;
    grid_type: number[];
    army_cnt: number[];
  }> {
    const dummyPlayerSids = meta.player_names.map((_, index) => `replay_sid_${index}`);
    const dummyPlayerIds = meta.player_names.map((_, index) => `replay_id_${index}`);

    const engine = new GameEngine(
      {
        ...meta,
        allow_team: meta.allow_team ?? false,
        fog: meta.fog === true,
        map_size_version: meta.map_size_version ?? 1,
        map_size: meta.map_size ?? 'normal',
        map_region: normalizeMapRegion(meta.map_region),
      },
      dummyPlayerSids,
      dummyPlayerIds,
      '__replay_build__',
      {
        update: () => undefined,
        emitInitMap: () => undefined,
        chatMessage: () => undefined,
        endGame: () => undefined,
        disciplineEvent: () => undefined,
        md5: (input) => input,
        replayStore: {
          saveReplay: async () => '',
        } as unknown as ReplayStore,
      },
    );

    await engine.initializeMap();
    engine.selectGenerals();
    const snapshot = engine.buildInitialReplayMapArrays();
    return {
      n: engine.n,
      m: engine.m,
      ...snapshot,
    };
  }

  static async buildReplayFromActions(replay: ReplayActionData): Promise<ReplayData> {
    if (!replay || replay.version !== 'ops-v1') {
      throw new Error('回放版本不兼容。');
    }
    const dummyPlayerSids = replay.meta.player_names.map((_, index) => `replay_sid_${index}`);
    const dummyPlayerIds = replay.meta.player_names.map((_, index) => `replay_id_${index}`);

    const engine = new GameEngine(
      {
        ...replay.meta,
        allow_team: replay.meta.allow_team ?? false,
        fog: replay.meta.fog === true,
        map_size_version: replay.meta.map_size_version ?? 1,
        map_size: replay.meta.map_size ?? 'normal',
        map_region: normalizeMapRegion(replay.meta.map_region),
      },
      dummyPlayerSids,
      dummyPlayerIds,
      '__replay_build__',
      {
        update: () => undefined,
        emitInitMap: () => undefined,
        chatMessage: () => undefined,
        endGame: () => undefined,
        disciplineEvent: () => undefined,
        md5: (input) => input,
        replayStore: {
          saveReplay: async () => '',
        } as unknown as ReplayStore,
      },
    );

    await engine.initializeMap();
    engine.selectGenerals();

    const { scheduledMoves, scheduledBuilds, scheduledSurrenders, scheduledTransfers } =
      buildScheduledReplayActions(replay);

    const initial = engine.buildReplayFrame(false);
    let prevFrame = initial;
    const patches: ReplayPatch[] = [];
    while (engine.turn < replay.total_turns) {
      const nextTurn = engine.turn + 1;
      for (let p = 0; p < scheduledSurrenders.length; p += 1) {
        if (!scheduledSurrenders[p].has(nextTurn)) {
          continue;
        }
        engine.surrender(engine.playerSids[p]);
      }
      for (let p = 0; p < scheduledTransfers.length; p += 1) {
        const transfer = scheduledTransfers[p].get(nextTurn);
        if (!transfer) {
          continue;
        }
        engine.applyCrownTransfer(p, transfer.x, transfer.y);
      }
      for (let p = 0; p < scheduledBuilds.length; p += 1) {
        const build = scheduledBuilds[p].get(nextTurn);
        if (!build) {
          continue;
        }
        engine.addBuild(engine.playerSids[p], build.x, build.y, build.kind);
      }
      for (let p = 0; p < scheduledMoves.length; p += 1) {
        const move = scheduledMoves[p].get(nextTurn);
        if (!move) {
          continue;
        }
        engine.addMove(engine.playerSids[p], move[0], move[1], move[2], move[3], move[4]);
      }

      const gameEnd = await engine.gameTick();
      const isFinalFrame = gameEnd || engine.turn >= replay.total_turns;
      const nextFrame = engine.buildReplayFrame(isFinalFrame);
      patches.push(buildReplayPatch(prevFrame, nextFrame));
      prevFrame = nextFrame;
      if (gameEnd) {
        break;
      }
    }

    if (patches.length === 0) {
      initial.game_end = true;
    }

    return {
      n: engine.n,
      m: engine.m,
      meta: replay.meta,
      initial,
      patches,
    };
  }

  startGame(): void {
    const delay = Math.max(10, this.startAt + 2000 - Date.now());
    this.tickTimer = setTimeout(() => {
      void this.beginLoop();
    }, delay);
  }

  private async beginLoop(): Promise<void> {
    this.lastTickAt = Date.now();
    this.initAfkTracking(this.lastTickAt);
    await this.sendMap(false);
    this.scheduleNextTick();
  }

  private initAfkTracking(nowMs: number): void {
    for (let p = 0; p < this.playerSids.length; p += 1) {
      if (this.team[p] === 0 || this.pstat[p] === LEFT_GAME) {
        continue;
      }
      this.afkLastMoveTurn[p] = this.turn;
      this.afkLastMoveAt[p] = nowMs;
    }
  }

  private scheduleNextTick(): void {
    const elapsed = Date.now() - this.lastTickAt;
    const delay = Math.max(10, 500 / this.speed - elapsed);
    this.tickTimer = setTimeout(() => {
      void this.tickOnce();
    }, delay);
  }

  private async tickOnce(): Promise<void> {
    this.lastTickAt = Date.now();
    const ended = await this.gameTick();
    // 清算路径（forceFinish）可能在本 Tick 结算期间接管终局，避免重复 finishGame。
    if (this.finished) {
      return;
    }
    if (ended) {
      this.finishGame();
      return;
    }
    this.scheduleNextTick();
  }

  private async initializeMap(): Promise<void> {
    const requiredPlayers = this.team.filter((team) => team !== 0).length;
    let generated;
    if (this.mapMode === 'maze') {
      generated = generateMazeMap(this.rng, {
        widthRatio: this.widthRatio,
        heightRatio: this.heightRatio,
        cityRatio: this.cityRatio,
        mountainRatio: this.mountainRatio,
        swampRatio: this.swampRatio,
      });
    } else if (this.mapMode === 'archipelago') {
      generated = generateArchipelagoMap(this.rng, {
        widthRatio: this.widthRatio,
        heightRatio: this.heightRatio,
        cityRatio: this.cityRatio,
        mountainRatio: this.mountainRatio,
        swampRatio: this.swampRatio,
        requiredPlayers,
      });
    } else if (this.mapMode === 'mediterranean') {
      generated = generateMediterraneanMap(this.rng, {
        widthRatio: this.widthRatio,
        heightRatio: this.heightRatio,
        cityRatio: this.cityRatio,
        mountainRatio: this.mountainRatio,
        swampRatio: this.swampRatio,
        requiredPlayers,
      });
    } else if (this.mapMode === 'huaxia') {
      generated = generateHuaxiaMap(this.rng, {
        widthRatio: this.widthRatio,
        heightRatio: this.heightRatio,
        cityRatio: this.cityRatio,
        mountainRatio: this.mountainRatio,
        swampRatio: this.swampRatio,
        mapRegion: this.mapRegion,
      });
    } else {
      generated = generateRandomMap(this.rng, {
        widthRatio: this.widthRatio,
        heightRatio: this.heightRatio,
        cityRatio: this.cityRatio,
        mountainRatio: this.mountainRatio,
        swampRatio: this.swampRatio,
      });
    }

    this.n = generated.n;
    this.m = generated.m;
    this.owner = generated.owner;
    this.armyCnt = generated.armyCnt;
    this.gridType = generated.gridType;
    this.st = generated.st;
    this.isolated = Array.from({ length: this.n }, () => Array.from({ length: this.m }, () => false));
    this.isolatedAge = Array.from({ length: this.n }, () => Array.from({ length: this.m }, () => 0));
  }

  private selectGenerals(): void {
    const requiredPlayers = this.team.filter((team) => team !== 0).length;
    let selected: GeneralPos[];
    if (this.mapMode === 'maze') {
      selected = selectMazeGenerals(
        {
          n: this.n,
          m: this.m,
          st: this.st,
          gridType: this.gridType,
          rng: this.rng,
        },
        requiredPlayers,
      );
    } else {
      selected = selectRandomGenerals(
        {
          n: this.n,
          m: this.m,
          st: this.st,
          gridType: this.gridType,
          rng: this.rng,
        },
        requiredPlayers,
      );
    }

    for (let i = 0; i < this.n; i += 1) {
      for (let j = 0; j < this.m; j += 1) {
        if (this.st[i][j] && this.gridType[i][j] === -2) {
          this.gridType[i][j] = 0;
          this.owner[i][j] = 0;
          this.armyCnt[i][j] = 0;
        }
      }
    }

    this.generals = Array.from({ length: this.playerSids.length }, () => [-1, -1]);
    let cursor = 0;
    for (let i = 0; i < this.playerSids.length; i += 1) {
      if (this.team[i] === 0) {
        this.pstat[i] = LEFT_GAME;
        continue;
      }
      const picked = selected[cursor];
      if (!picked || (picked[0] === -1 && picked[1] === -1)) {
        this.pstat[i] = LEFT_GAME;
      } else {
        this.generals[i] = [picked[0], picked[1]];
        this.gridType[picked[0]][picked[1]] = -2;
        this.owner[picked[0]][picked[1]] = i + 1;
        this.armyCnt[picked[0]][picked[1]] = 1;
      }
      cursor += 1;
    }
  }

  private chkxy(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.n && y < this.m;
  }

  private buildLeaderboard() {
    return buildLeaderboard({
      n: this.n,
      m: this.m,
      owner: this.owner,
      armyCnt: this.armyCnt,
      playerSidsLength: this.playerSids.length,
      names: this.names,
      team: this.team,
      pstat: this.pstat,
      deadOrder: this.deadOrder,
      leftGameValue: LEFT_GAME,
    });
  }

  private buildInitialReplayMapArrays(): {
    grid_type: number[];
    army_cnt: number[];
    isolated: number[];
  } {
    return buildFullVisionArrays({
      n: this.n,
      m: this.m,
      gridType: this.gridType,
      owner: this.owner,
      armyCnt: this.armyCnt,
      isolated: this.isolated,
      isolatedAge: this.isolatedAge,
    });
  }

  private buildReplayFrame(gameEnd: boolean): UpdatePayload {
    const snapshot = this.buildInitialReplayMapArrays();
    return {
      grid_type: snapshot.grid_type,
      army_cnt: snapshot.army_cnt,
      isolated: snapshot.isolated,
      lst_move: { x: -1, y: -1, dx: -1, dy: -1, half: false, mode: 0, op: 'm' },
      leaderboard: this.buildLeaderboard(),
      turn: this.turn,
      kills: {},
      game_end: gameEnd,
      is_diff: false,
    };
  }

  private recordReplayTurnMoves(): void {
    this.replayTurnMoves.push(buildTurnMoves(this.lstMove));
  }

  private buildReplayPlayerOps() {
    return buildReplayPlayerOps(
      this.playerSids.length,
      this.replayTurnMoves,
      this.replayTurnSurrenders,
      this.replayTurnTransfers,
    );
  }

  private buildFinalRank(): string[] {
    return buildFinalRank(this.buildLeaderboard());
  }

  private buildFinalRankTeams(): { members: string[]; color: number }[] {
    return buildFinalRankTeams(this.buildLeaderboard());
  }

  private buildGameResult(): GameResultEntry[] {
    const leaderboard = this.buildLeaderboard();
    const sorted = buildFinalRank(leaderboard);
    const rankByUid = new Map<string, number>(sorted.map((uid, index) => [uid, index + 1]));
    const result: GameResultEntry[] = [];
    for (const entry of leaderboard) {
      result.push({
        uid: entry.uid,
        team: entry.team,
        rank: rankByUid.get(entry.uid) ?? leaderboard.length,
      });
    }
    return result;
  }

  private toMovePayload(op: QueuedOp | null, skip = 0): UpdatePayload['lst_move'] {
    if (!op) {
      return { x: -1, y: -1, dx: -1, dy: -1, half: false, mode: 0, op: 'm', skip };
    }
    if (op.kind === 'm') {
      return {
        x: op.x,
        y: op.y,
        dx: op.dx,
        dy: op.dy,
        half: op.mode === 1,
        mode: op.mode,
        op: 'm',
        skip,
      };
    }
    return { x: op.x, y: op.y, dx: -1, dy: -1, half: false, mode: 0, op: op.kind, skip };
  }

  /**
   * 迷雾是否作用于该玩家：仅存活参赛者被过滤；观战席（team 0）、
   * 已出局转观战者与外部观战者始终全视野。
   */
  private fogAppliesToPlayer(p: number): boolean {
    return this.fogEnabled && this.team[p] !== 0 && !this.spec[p] && this.pstat[p] !== LEFT_GAME;
  }

  /** 当前棋盘状态（fog-vision / map-encoding 共用的输入视图）。 */
  private boardState() {
    return {
      n: this.n,
      m: this.m,
      gridType: this.gridType,
      owner: this.owner,
      armyCnt: this.armyCnt,
      isolated: this.isolated,
      isolatedAge: this.isolatedAge,
    };
  }

  /**
   * 按指定队伍的可见性构建迷雾过滤快照（队伍内所有玩家共享同一视野）。
   * visionCache 按 tick 复用，避免同队多接收者重复计算可见格。
   */
  private buildTeamFoggedSnapshot(
    teamId: number,
    visionCache: Map<number, number[]>,
  ): { grid_type: number[]; army_cnt: number[]; isolated: number[]; fog: number[] } {
    let visible = visionCache.get(teamId);
    if (!visible) {
      visible = computeTeamVisibility(
        this.n,
        this.m,
        this.owner,
        (ownerId) => this.team[ownerId - 1],
        teamId,
      );
      visionCache.set(teamId, visible);
    }
    return buildFoggedVisionArrays(this.boardState(), visible);
  }

  /**
   * 按接收者构建地图快照（p = -1 表示观战者）。迷雾对局中存活参赛者得到
   * 视野过滤后的数组与 fog 标记；其余接收者为全视野。fog 仅在迷雾对局
   * 中非 null（全视野接收者为全 0，用于复位客户端可能残留的遮罩）。
   */
  private buildSnapshotFor(
    p: number,
    visionCache: Map<number, number[]>,
  ): { grid_type: number[]; army_cnt: number[]; isolated: number[]; fog: number[] | null } {
    if (p >= 0 && this.fogAppliesToPlayer(p)) {
      return this.buildTeamFoggedSnapshot(this.team[p], visionCache);
    }
    const arrays = buildFullVisionArrays(this.boardState());
    return {
      ...arrays,
      fog: this.fogEnabled ? new Array<number>(this.n * this.m).fill(0) : null,
    };
  }

  private async sendMap(stat: boolean): Promise<void> {
    let historyHash: string | undefined;

    const kills = this.recentKills;
    this.recentKills = {};
    const leaderboard = this.buildLeaderboard();
    const visionCache = new Map<number, number[]>();

    for (let p = -1; p < this.playerSids.length; p += 1) {
      if (p !== -1 && !this.watching[p]) {
        continue;
      }
      // 观战席/已战败玩家可按 spectatorViewTeams 选择的队伍视角接收迷雾帧；
      // diff 基线始终记录「最后实际下发的快照」，跨视角切换由 setSpectatorView
      // 补发的全量帧重新对齐，因此这里照常 diff 即可。
      const povTeam = p >= 0 && this.fogEnabled ? (this.spectatorViewTeams.get(this.playerSids[p]) ?? 0) : 0;
      const snapshot =
        povTeam > 0
          ? this.buildTeamFoggedSnapshot(povTeam, visionCache)
          : this.buildSnapshotFor(p, visionCache);

      const lstMovePayload = this.toMovePayload(
        p === -1 ? null : this.lstMove[p],
        p === -1 ? 0 : this.lstSkip[p],
      );
      const fullSnapshot = stat || p === -1 || this.turn % 50 === 0 || randomInt(51) === 0;

      const payload: UpdatePayload = fullSnapshot
        ? {
            grid_type: snapshot.grid_type,
            army_cnt: snapshot.army_cnt,
            isolated: snapshot.isolated,
            lst_move: lstMovePayload,
            leaderboard,
            turn: this.turn,
            kills,
            game_end: stat,
            is_diff: false,
          }
        : {
            grid_type: getDiff(snapshot.grid_type, this.gridTypeLast[p]),
            army_cnt: getDiff(snapshot.army_cnt, this.armyCntLast[p]),
            isolated: getDiff(snapshot.isolated, this.isolatedLast[p]),
            lst_move: lstMovePayload,
            leaderboard,
            turn: this.turn,
            kills,
            game_end: stat,
            is_diff: true,
          };

      if (snapshot.fog) {
        payload.fog = fullSnapshot ? snapshot.fog : getDiff(snapshot.fog, this.fogLast[p]);
      }

      if (historyHash) {
        payload.replay = historyHash;
      }

      if (p !== -1) {
        this.gridTypeLast[p] = snapshot.grid_type;
        this.armyCntLast[p] = snapshot.army_cnt;
        this.isolatedLast[p] = snapshot.isolated;
        if (snapshot.fog) {
          this.fogLast[p] = snapshot.fog;
        }
        this.lstMove[p] = null;
        this.lstSkip[p] = 0;
        this.update(this.playerSids[p], payload);
      } else {
        if (stat) {
          historyHash = await this.saveHistory();
          payload.replay = historyHash;
        }
        // 外部观战者默认共享全图帧；选了玩家视角的单独按该队伍视野出全量帧
        // （观战者基数小，且复用本 tick 的 visionCache，不影响正常广播）。
        for (const spectatorSid of this.externalSpectatorSids) {
          const povTeam = this.fogEnabled ? (this.spectatorViewTeams.get(spectatorSid) ?? 0) : 0;
          if (povTeam > 0) {
            const povPayload = this.fullFrameFromSnapshot(
              this.buildTeamFoggedSnapshot(povTeam, visionCache),
              stat,
            );
            if (historyHash) {
              povPayload.replay = historyHash;
            }
            this.update(spectatorSid, povPayload);
          } else {
            this.update(spectatorSid, payload);
          }
        }
      }
    }
  }

  private buildFullVisionPayload(gameEnd: boolean): UpdatePayload {
    return this.buildFullFramePayload(-1, gameEnd);
  }

  /** 由快照组装全量帧（is_diff=false）。 */
  private fullFrameFromSnapshot(
    snapshot: { grid_type: number[]; army_cnt: number[]; isolated: number[]; fog: number[] | null },
    gameEnd: boolean,
  ): UpdatePayload {
    const payload: UpdatePayload = {
      grid_type: snapshot.grid_type,
      army_cnt: snapshot.army_cnt,
      isolated: snapshot.isolated,
      lst_move: { x: -1, y: -1, dx: -1, dy: -1, half: false, mode: 0, op: 'm' },
      leaderboard: this.buildLeaderboard(),
      turn: this.turn,
      kills: {},
      game_end: gameEnd,
      is_diff: false,
    };
    if (snapshot.fog) {
      payload.fog = snapshot.fog;
    }
    return payload;
  }

  /**
   * 全量帧（is_diff=false）：观战者恒为全视野；参赛者按迷雾规则过滤，
   * 用于断线重连换绑后的状态补发。
   */
  private buildFullFramePayload(p: number, gameEnd: boolean): UpdatePayload {
    return this.fullFrameFromSnapshot(this.buildSnapshotFor(p, new Map<number, number[]>()), gameEnd);
  }

  addMove(playerSid: string, x: number, y: number, dx: number, dy: number, mode: MoveMode): void {
    const player = this.playerSidToIndex.get(playerSid);
    if (typeof player === 'undefined') {
      return;
    }
    if (this.pstat[player] === LEFT_GAME) {
      return;
    }
    this.pmove[player].push({ kind: 'm', x, y, dx, dy, mode });
  }

  addBuild(playerSid: string, x: number, y: number, kind: 'b' | 'c'): void {
    const player = this.playerSidToIndex.get(playerSid);
    if (typeof player === 'undefined') {
      return;
    }
    if (this.pstat[player] === LEFT_GAME) {
      return;
    }
    this.pmove[player].push({ kind, x, y });
  }

  clearQueue(playerSid: string): void {
    const player = this.playerSidToIndex.get(playerSid);
    if (typeof player === 'undefined') {
      return;
    }
    this.pmove[player] = [];
  }

  popQueue(playerSid: string): void {
    const player = this.playerSidToIndex.get(playerSid);
    if (typeof player === 'undefined') {
      return;
    }
    if (this.pmove[player].length > 0) {
      this.pmove[player].pop();
    }
  }

  addSpectator(sid: string): void {
    if (this.externalSpectatorSids.has(sid)) {
      return;
    }
    this.externalSpectatorSids.add(sid);
    this.emitInitMap(sid, {
      n: this.n,
      m: this.m,
      player_ids: [...this.playerIds],
      general: [-1, -1],
    });
    this.update(sid, this.buildFullVisionPayload(false));
  }

  removeSpectator(sid: string): void {
    this.externalSpectatorSids.delete(sid);
    this.spectatorViewTeams.delete(sid);
  }

  /**
   * 观战视角切换（纯显示层，仅迷雾对局）：team > 0 时该连接改看指定队伍的
   * 迷雾视野，team <= 0（或队伍不存在）恢复全图。存活参赛者的请求直接忽略，
   * 防止借观战视角窥探他队视野；对局内玩家的迷雾计算不受影响。
   * 切换后立即补发一帧全量帧（并同步 diff 基线），客户端无需等到下个 Tick。
   */
  setSpectatorView(sid: string, team: number): void {
    if (!this.fogEnabled || this.isActiveParticipant(sid)) {
      return;
    }
    const povTeam = Number.isInteger(team) && team > 0 && this.team.includes(team) ? team : 0;
    if (povTeam > 0) {
      this.spectatorViewTeams.set(sid, povTeam);
    } else {
      this.spectatorViewTeams.delete(sid);
    }
    const visionCache = new Map<number, number[]>();
    const snapshot =
      povTeam > 0
        ? this.buildTeamFoggedSnapshot(povTeam, visionCache)
        : this.buildSnapshotFor(-1, visionCache);
    // 基线 = 最后实际下发的快照：座位上（观战席/已战败）的接收者后续 diff 帧
    // 以此为基准，外部观战者本就只收全量帧、无基线。
    const idx = this.playerSidToIndex.get(sid);
    if (idx !== undefined) {
      this.gridTypeLast[idx] = snapshot.grid_type;
      this.armyCntLast[idx] = snapshot.army_cnt;
      this.isolatedLast[idx] = snapshot.isolated;
      if (snapshot.fog) {
        this.fogLast[idx] = snapshot.fog;
      }
    }
    this.update(sid, this.fullFrameFromSnapshot(snapshot, false));
  }

  /**
   * 该连接是否为当前对局中仍存活的参赛者。
   * 观战席位（team 0）、已战败/已投降玩家均返回 false，
   * 用于放行对局进行中「下局模式」（观战/参与）的换队请求。
   */
  isActiveParticipant(sid: string): boolean {
    const idx = this.playerSidToIndex.get(sid);
    return idx !== undefined && this.team[idx] !== 0 && this.deadOrder[idx] === 0;
  }

  /**
   * 标记玩家掉线：只记录时间戳，不投降、不清队列、不移除 watching；
   * 已排队操作在宽限期内继续正常执行。
   */
  markDisconnected(sid: string): boolean {
    if (!this.enableAfkSurrender) {
      return false;
    }
    const id = this.playerSidToIndex.get(sid);
    if (typeof id === 'undefined') {
      return false;
    }
    if (this.team[id] === 0 || this.pstat[id] === LEFT_GAME) {
      return false;
    }
    this.disconnectedAt[id] = Date.now();
    return true;
  }

  /**
   * 按用户名查找仍在参赛（team!==0 且未出局）的玩家，返回其当前 sid。
   * 不要求已标记断线，以覆盖顶号时新连接的 join_game_room 先于
   * 旧 socket 的 disconnect 事件到达的竞态。
   */
  findPlayerSidByName(username: string): string | null {
    for (let i = 0; i < this.playerSids.length; i += 1) {
      if (this.names[i] === username && this.team[i] !== 0 && this.pstat[i] !== LEFT_GAME) {
        return this.playerSids[i];
      }
    }
    return null;
  }

  /**
   * 断线重连换绑：把玩家的 sid/client_id（md5(sid)）换到新 socket，
   * 清空操作队列（客户端 route 已丢，避免幽灵操作）、重置 AFK 计时，
   * 并补发 init_map + 全量视野帧让客户端恢复画面。
   */
  rebindPlayer(oldSid: string, newSid: string): boolean {
    const id = this.playerSidToIndex.get(oldSid);
    if (typeof id === 'undefined') {
      return false;
    }
    this.playerSidToIndex.delete(oldSid);
    this.playerSidToIndex.set(newSid, id);
    this.playerSids[id] = newSid;
    this.playerIds[id] = this.md5(newSid);
    // 观战视角偏好随 sid 换绑迁移（观战席/已战败玩家重连后保留所选视角）。
    const povTeam = this.spectatorViewTeams.get(oldSid) ?? 0;
    if (povTeam > 0) {
      this.spectatorViewTeams.delete(oldSid);
      this.spectatorViewTeams.set(newSid, povTeam);
    }
    this.disconnectedAt[id] = null;
    this.watching[id] = true;
    this.afkLastMoveTurn[id] = this.turn;
    this.afkLastMoveAt[id] = Date.now();
    this.pmove[id] = [];
    this.emitInitMap(newSid, {
      n: this.n,
      m: this.m,
      player_ids: [...this.playerIds],
      general: this.generals[id],
    });
    // 换绑后补发全量帧：保留观战席/已战败玩家已选的观战视角；同时把 diff 基线
    // 对齐到本次补发的快照（客户端 init_map 已重置棋盘，后续 diff 以此为准）。
    const snapshot =
      povTeam > 0 && this.fogEnabled
        ? this.buildTeamFoggedSnapshot(povTeam, new Map<number, number[]>())
        : this.buildSnapshotFor(id, new Map<number, number[]>());
    this.gridTypeLast[id] = snapshot.grid_type;
    this.armyCntLast[id] = snapshot.army_cnt;
    this.isolatedLast[id] = snapshot.isolated;
    if (snapshot.fog) {
      this.fogLast[id] = snapshot.fog;
    }
    this.update(newSid, this.fullFrameFromSnapshot(snapshot, false));
    return true;
  }

  /**
   * 宽限期到期：仍以旧 sid 登记断线的玩家以「挂机」原因投降（复用挂机投降路径）。
   * 已重连（sid 已换绑或时间戳已清除）时返回 false，天然幂等；
   * 宽限期内已被对手击杀（LEFT_GAME）时不再重复投降，但仍返回 true 以便调用方完成离开清理。
   */
  expireDisconnect(sid: string): boolean {
    if (!this.enableAfkSurrender) {
      return false;
    }
    const id = this.playerSidToIndex.get(sid);
    if (typeof id === 'undefined' || this.disconnectedAt[id] === null) {
      return false;
    }
    this.disconnectedAt[id] = null;
    if (this.applySurrenderByIndex(id, 'disconnect_timeout')) {
      this.sendSystemMessage(`${this.names[id]} 掉线超过宽限期，自动投降并转为观战。`);
      this.scheduleImmediateTick();
    }
    return true;
  }

  sendMessage(sid: string, data: { text: string; team: boolean }): void {
    const id = this.playerSidToIndex.get(sid);
    if (typeof id === 'undefined') {
      return;
    }
    const text = data.text.trim();
    if (text.length === 0) {
      return;
    }
    const uid = this.names[id];
    if (data.team) {
      for (let i = 0; i < this.playerSids.length; i += 1) {
        if (this.team[i] === this.team[id]) {
          this.chatMessage(this.playerSids[i], 'sid', uid, id + 1, text, true);
        }
      }
      return;
    }

    this.chatMessage(this.gid, 'room', uid, id + 1, text);
  }

  private sendSystemMessage(text: string): void {
    this.chatMessage(this.gid, 'room', '', 0, text);
  }

  private markEliminated(playerIndex: number): void {
    if (this.pstat[playerIndex] !== LEFT_GAME) {
      this.pstat[playerIndex] = LEFT_GAME;
      this.deadCount += 1;
      this.deadOrder[playerIndex] = this.deadCount;
    }
    this.spec[playerIndex] = true;
  }

  /**
   * 拆除一名玩家的全部锚点（主城/指挥所降级为普通格），并将其所有领土
   * 打入孤军状态（标记 isolated、isolatedAge=1）。尚未 isolated 的格子
   * 施加与断链相同的减半惩罚（1 兵特例保持为 1），减半后兵力归零的格子
   * 变为中立；此前断链时已 isolated（已减半过）的格子不再重复减半。
   * 之后按既有孤军规则自然衰减至中立。
   */
  private teardownEmpire(victim: number): void {
    for (let i = 0; i < this.n; i += 1) {
      for (let j = 0; j < this.m; j += 1) {
        if (this.owner[i][j] === victim) {
          if (this.gridType[i][j] === -1 || this.gridType[i][j] === -2) {
            this.gridType[i][j] = 0;
          }
          if (!this.isolated[i][j]) {
            this.armyCnt[i][j] = this.armyCnt[i][j] === 1 ? 1 : Math.floor(this.armyCnt[i][j] / 2);
            if (this.armyCnt[i][j] <= 0) {
              this.owner[i][j] = 0;
              this.armyCnt[i][j] = 0;
              this.isolated[i][j] = false;
              this.isolatedAge[i][j] = 0;
              continue;
            }
          }
          this.isolated[i][j] = true;
          this.isolatedAge[i][j] = 1;
        }
      }
    }
  }

  /**
   * 败者出局：领土【不】转移给攻击方，全部保持原归属并减半后进入孤军衰减。
   * attacker = 0（系统接管 AFK/掉线）走同一代码路径，不再特殊处理。
   */
  private kill(attacker: number, victim: number): void {
    this.teardownEmpire(victim);

    this.markEliminated(victim - 1);

    if (attacker > 0 && victim > 0) {
      this.recentKills[this.md5(this.playerSids[victim - 1])] = this.names[attacker - 1];
      this.sendSystemMessage(`${this.names[attacker - 1]} 攻陷了 ${this.names[victim - 1]} 的主城。`);
    } else if (victim > 0) {
      this.recentKills[this.md5(this.playerSids[victim - 1])] = '系统';
    }
  }

  private countCrowns(ownerId: number): number {
    let count = 0;
    for (let i = 0; i < this.n; i += 1) {
      for (let j = 0; j < this.m; j += 1) {
        if (this.gridType[i][j] === -2 && this.owner[i][j] === ownerId) {
          count += 1;
        }
      }
    }
    return count;
  }

  private chkMove(x: number, y: number, dx: number, dy: number, p: number): boolean {
    return (
      this.chkxy(x, y) &&
      this.chkxy(dx, dy) &&
      Math.abs(x - dx) + Math.abs(y - dy) === 1 &&
      this.owner[x][y] === p + 1 &&
      !this.isolated[x][y] &&
      this.armyCnt[x][y] > 0 &&
      this.gridType[dx][dy] !== 1
    );
  }

  /**
   * 智能分兵：B 为其他三个方向上所有非己方相邻格的可动兵力（兵力 - 1）总和，
   * 保留 = B + 1，理论推出 = max(0, A - B - 1)。本次目标格不参与保留计算。
   * 半兵取理论推出减半取整；全冲只保留 1 兵。推出量物理上限为 A - 1。
   */
  private computePush(x: number, y: number, dx: number, dy: number, mode: MoveMode): number {
    const total = this.armyCnt[x][y];
    const cap = Math.max(0, total - 1);
    if (mode === 2) {
      return cap;
    }

    let defense = 0;
    for (let d = 0; d < 4; d += 1) {
      const nx = x + MOVE_DX[d];
      const ny = y + MOVE_DY[d];
      if (nx === dx && ny === dy) {
        continue;
      }
      if (!this.chkxy(nx, ny) || this.gridType[nx][ny] === 1) {
        continue;
      }
      const neighborOwner = this.owner[nx][ny];
      if (neighborOwner > 0 && this.team[neighborOwner - 1] === this.team[this.owner[x][y] - 1]) {
        continue;
      }
      defense += this.armyCnt[nx][ny] - 1;
    }

    const theoretical = Math.max(0, total - defense - 1);
    const push = mode === 1 ? Math.floor(theoretical / 2) : theoretical;
    return Math.min(push, cap);
  }

  /**
   * 结算一次推兵。返回 true 表示产生了实际效果；
   * 推出 0 兵时推兵无效，不产生任何状态变化。
   * 攻击兵力严格大于防守兵力才占领；未严格大于（含相等）时进攻失败但双方
   * 结算损耗：进攻方损失全部推出兵力，防守方减去等量兵力（最低到 0，
   * 不变更归属、不摧毁建筑）。
   */
  private attack(x: number, y: number, dx: number, dy: number, mode: MoveMode): boolean {
    const cnt = this.computePush(x, y, dx, dy, mode);
    if (cnt <= 0) {
      return false;
    }

    const attacker = this.owner[x][y];
    const defender = this.owner[dx][dy];

    if (defender === attacker) {
      this.armyCnt[x][y] -= cnt;
      this.armyCnt[dx][dy] += cnt;
      return true;
    }

    if (defender > 0 && this.team[defender - 1] === this.team[attacker - 1]) {
      this.armyCnt[x][y] -= cnt;
      this.armyCnt[dx][dy] += cnt;
      if (this.gridType[dx][dy] !== -2) {
        this.owner[dx][dy] = attacker;
      }
      return true;
    }

    if (cnt <= this.armyCnt[dx][dy]) {
      // 进攻失败但双方互损：进攻方损失全部推出兵力，防守方减去等量兵力（最低到 0）。
      this.armyCnt[x][y] -= cnt;
      this.armyCnt[dx][dy] -= cnt;
      return true;
    }

    // 攻击成功：防守兵力全灭，新兵力 = 推出兵力 − 防守兵力；建筑被摧毁。
    const wasCrown = this.gridType[dx][dy] === -2;
    const defense = this.armyCnt[dx][dy];
    this.armyCnt[x][y] -= cnt;
    if (this.gridType[dx][dy] === -1 || wasCrown) {
      this.gridType[dx][dy] = 0;
    }
    this.owner[dx][dy] = attacker;
    this.armyCnt[dx][dy] = cnt - defense;
    this.isolated[dx][dy] = false;
    this.isolatedAge[dx][dy] = 0;

    if (wasCrown && defender > 0 && this.countCrowns(defender) === 0) {
      // 敌方最后一座主城被占领：立即出局，剩余领土全部沦为孤军（见 kill）。
      this.kill(attacker, defender);
    }
    return true;
  }

  /**
   * X 建指挥所：己方、正常状态、普通地块、兵力 >= 50。
   * 正常状态即已连通己方任意主城或指挥所。
   */
  private chkBuildCity(x: number, y: number, p: number): boolean {
    return (
      this.chkxy(x, y) &&
      this.owner[x][y] === p + 1 &&
      !this.isolated[x][y] &&
      this.gridType[x][y] === 0 &&
      this.armyCnt[x][y] >= BUILD_COST
    );
  }

  /**
   * C 升级主城：己方、正常状态的指挥所、兵力 >= 50。
   */
  private chkUpgradeCrown(x: number, y: number, p: number): boolean {
    return (
      this.chkxy(x, y) &&
      this.owner[x][y] === p + 1 &&
      !this.isolated[x][y] &&
      this.gridType[x][y] === -1 &&
      this.armyCnt[x][y] >= BUILD_COST
    );
  }

  private applyIsolatedDecay(x: number, y: number): void {
    const current = this.armyCnt[x][y];
    const decay = Math.max(1, Math.ceil(current * ISOLATED_DECAY_RATIO));
    if (current - decay <= 0) {
      this.owner[x][y] = 0;
      this.armyCnt[x][y] = 0;
      if (this.gridType[x][y] === -1 || this.gridType[x][y] === -2) {
        this.gridType[x][y] = 0;
      }
      this.isolated[x][y] = false;
      this.isolatedAge[x][y] = 0;
      return;
    }
    this.armyCnt[x][y] = current - decay;
  }

  /**
   * 重算全部玩家的领土连通，并处理断链减半、孤军衰减、重连翻倍的即时状态转移。
   * 连通按【队伍】计算：以队内任意存活成员的主城/指挥所为锚点，经由队内存活成员
   * 的格子四方向连通——只要整支队伍在某一块里还握有任意一座主城/指挥所，
   * 该块内全队领土都保持正常可操控。已出局玩家的领土不参与连通（kill/投降时已
   * 强制打入孤军），继续衰减直至中立。
   * 断裂衰减节奏：断链瞬间减半（1 兵特例保持为 1）后进入 5 回合（10 Tick）宽限期，
   * 宽限期内只快速闪烁不衰减；第 11 Tick 起每回合（2 Tick）执行一次 5% 衰减。
   */
  private isAliveTeamMember(ownerId: number, teamId: number): boolean {
    return this.team[ownerId - 1] === teamId && this.pstat[ownerId - 1] !== LEFT_GAME;
  }

  private applyConnectivity(): void {
    const connected: Grid<boolean> = Array.from({ length: this.n }, () =>
      Array.from({ length: this.m }, () => false),
    );

    const visitQueue: number[] = [];
    const processedTeams = new Set<number>();
    for (let p = 0; p < this.playerSids.length; p += 1) {
      if (this.pstat[p] === LEFT_GAME) {
        continue;
      }
      const teamId = this.team[p];
      if (processedTeams.has(teamId)) {
        continue;
      }
      processedTeams.add(teamId);
      visitQueue.length = 0;
      for (let i = 0; i < this.n; i += 1) {
        for (let j = 0; j < this.m; j += 1) {
          const tile = this.gridType[i][j];
          const ownerId = this.owner[i][j];
          if (ownerId > 0 && (tile === -2 || tile === -1) && this.isAliveTeamMember(ownerId, teamId)) {
            connected[i][j] = true;
            visitQueue.push(i * this.m + j);
          }
        }
      }

      let head = 0;
      while (head < visitQueue.length) {
        const index = visitQueue[head];
        head += 1;
        const x = Math.floor(index / this.m);
        const y = index % this.m;
        for (let d = 0; d < 4; d += 1) {
          const nx = x + MOVE_DX[d];
          const ny = y + MOVE_DY[d];
          if (!this.chkxy(nx, ny) || connected[nx][ny]) {
            continue;
          }
          const nOwner = this.owner[nx][ny];
          if (nOwner <= 0 || !this.isAliveTeamMember(nOwner, teamId) || this.gridType[nx][ny] === 1) {
            continue;
          }
          connected[nx][ny] = true;
          visitQueue.push(nx * this.m + ny);
        }
      }
    }

    for (let i = 0; i < this.n; i += 1) {
      for (let j = 0; j < this.m; j += 1) {
        const ownerId = this.owner[i][j];
        if (ownerId <= 0) {
          this.isolated[i][j] = false;
          this.isolatedAge[i][j] = 0;
          continue;
        }

        const wasIsolated = this.isolated[i][j];
        if (connected[i][j]) {
          if (wasIsolated) {
            // 重连：恢复正常，兵力按当前兵力 ×2。
            this.isolated[i][j] = false;
            this.isolatedAge[i][j] = 0;
            this.armyCnt[i][j] *= 2;
          }
          continue;
        }

        if (!wasIsolated) {
          // 新断链：立即减半（1 兵特例保持为 1），随后进入宽限期，本 Tick 不衰减。
          this.isolated[i][j] = true;
          this.isolatedAge[i][j] = 1;
          this.armyCnt[i][j] = this.armyCnt[i][j] === 1 ? 1 : Math.floor(this.armyCnt[i][j] / 2);
          if (this.armyCnt[i][j] <= 0) {
            this.owner[i][j] = 0;
            this.armyCnt[i][j] = 0;
            this.isolated[i][j] = false;
            this.isolatedAge[i][j] = 0;
          }
          continue;
        }

        // 孤军衰减：前 10 Tick（5 回合）为宽限期，只闪烁不衰减；
        // 第 11 Tick 起每回合（每 2 Tick）执行一次 5% 衰减。
        this.isolatedAge[i][j] += 1;
        if (this.isolatedAge[i][j] > ISOLATED_GRACE_TICKS && this.isolatedAge[i][j] % 2 === 1) {
          this.applyIsolatedDecay(i, j);
        }
      }
    }
  }

  private async gameTick(): Promise<boolean> {
    this.turn += 1;
    const nowMs = Date.now();

    applyTickGrowth({
      turn: this.turn,
      n: this.n,
      m: this.m,
      gridType: this.gridType,
      owner: this.owner,
      armyCnt: this.armyCnt,
      isolated: this.isolated,
      pstat: this.pstat,
      leftGameValue: LEFT_GAME,
    });

    for (let p = 0; p < this.playerSids.length; p += 1) {
      if (this.pstat[p] !== 0) {
        this.pstat[p] = Math.min(this.pstat[p] + 1, LEFT_GAME);
        if (this.pstat[p] === LEFT_GAME - 1) {
          this.kill(0, p + 1);
        }
      }
    }

    const order = Array.from({ length: this.playerSids.length }, (_, i) => i);
    if (this.turn % 2 === 1) {
      order.reverse();
    }

    const movedThisTurn = Array.from({ length: this.playerSids.length }, () => false);
    for (const p of order) {
      if (this.pstat[p] === LEFT_GAME) {
        continue;
      }
      let skipped = 0;
      while (this.pmove[p].length > 0) {
        const op = this.pmove[p].shift();
        if (!op) {
          skipped += 1;
          continue;
        }
        if (op.kind === 'm') {
          if (!this.chkMove(op.x, op.y, op.dx, op.dy, p)) {
            skipped += 1;
            continue;
          }
          if (!this.attack(op.x, op.y, op.dx, op.dy, op.mode)) {
            skipped += 1;
            continue;
          }
        } else if (op.kind === 'b') {
          // 建造条件不满足时自动跳过，队列继续向后执行。
          if (!this.chkBuildCity(op.x, op.y, p)) {
            skipped += 1;
            continue;
          }
          this.armyCnt[op.x][op.y] -= BUILD_COST;
          this.gridType[op.x][op.y] = -1;
        } else {
          if (!this.chkUpgradeCrown(op.x, op.y, p)) {
            skipped += 1;
            continue;
          }
          this.armyCnt[op.x][op.y] -= BUILD_COST;
          this.gridType[op.x][op.y] = -2;
        }
        this.lstMove[p] = op;
        movedThisTurn[p] = true;
        break;
      }
      this.lstSkip[p] = skipped;
    }

    this.applyConnectivity();

    for (let p = 0; p < movedThisTurn.length; p += 1) {
      if (!movedThisTurn[p]) {
        continue;
      }
      this.afkLastMoveTurn[p] = this.turn;
      this.afkLastMoveAt[p] = nowMs;
    }
    this.applyAfkSurrender(nowMs);

    const aliveTeams: Record<number, true> = {};
    for (const p of order) {
      if (this.pstat[p] !== LEFT_GAME) {
        aliveTeams[this.team[p]] = true;
      }
    }

    const gameEnd = Object.keys(aliveTeams).length <= 1;
    this.recordReplayTurnMoves();
    await this.sendMap(gameEnd);
    return gameEnd;
  }

  leaveGame(sid: string): void {
    const id = this.playerSidToIndex.get(sid);
    if (typeof id === 'undefined') {
      return;
    }
    this.applySurrenderByIndex(id, 'leave');
    this.pmove[id] = [];
    this.watching[id] = false;
    this.sendSystemMessage(`${this.names[id]} 离开了游戏。`);
    this.scheduleImmediateTick();
  }

  surrender(sid: string): void {
    const id = this.playerSidToIndex.get(sid);
    if (typeof id === 'undefined') {
      return;
    }
    const changed = this.applySurrenderByIndex(id, 'manual_surrender');
    if (!changed) {
      return;
    }
    this.sendSystemMessage(`${this.names[id]} 投降并转为观战。`);
    this.scheduleImmediateTick();
  }

  /**
   * 队友间主城转让（issue #81）：请求方点击队友的主城发起请求，
   * 经拥有者确认后该格主城改属请求方（gridType 保持 -2，只改 owner）。
   * 核心限制：拥有者转让后必须仍保有至少一座主城（不能转走自己的最后一座）。
   */

  /** 转让条件校验（实时确认与回放重建共用）：目标格仍是该队友的主城，且其转让后仍剩 ≥1 座。 */
  private applyCrownTransfer(requester: number, x: number, y: number): boolean {
    if (this.finished || !this.chkxy(x, y)) {
      return false;
    }
    const giverId = this.owner[x][y];
    if (giverId <= 0) {
      return false;
    }
    const giver = giverId - 1;
    if (
      this.gridType[x][y] !== -2 ||
      giver === requester ||
      this.team[giver] !== this.team[requester] ||
      this.pstat[giver] === LEFT_GAME ||
      this.pstat[requester] === LEFT_GAME ||
      this.countCrowns(giverId) < 2
    ) {
      return false;
    }
    this.owner[x][y] = requester + 1;
    return true;
  }

  private notifyPlayerSystemMessage(playerIndex: number, text: string): void {
    this.chatMessage(this.playerSids[playerIndex], 'sid', '', 0, text);
  }

  /** 请求方发起主城转让请求：服务端完成全部校验后才转发给拥有者确认。 */
  requestCrownTransfer(sid: string, x: number, y: number): void {
    const requester = this.playerSidToIndex.get(sid);
    if (typeof requester === 'undefined') {
      return;
    }
    if (this.finished || this.team[requester] === 0 || this.pstat[requester] === LEFT_GAME) {
      return;
    }
    if (!this.chkxy(x, y)) {
      return;
    }
    const giverId = this.owner[x][y];
    if (this.gridType[x][y] !== -2 || giverId <= 0 || giverId === requester + 1) {
      return;
    }
    const giver = giverId - 1;
    if (this.team[giver] !== this.team[requester] || this.pstat[giver] === LEFT_GAME) {
      return;
    }
    if (this.countCrowns(giverId) < 2) {
      this.notifyPlayerSystemMessage(requester, '这是对方最后一座主城，不能转让。');
      return;
    }
    if (this.crownTransferPending.has(giver)) {
      this.notifyPlayerSystemMessage(requester, '对方还有未处理的主城转让请求，请稍后再试。');
      return;
    }
    const timer = setTimeout(() => {
      const pending = this.crownTransferPending.get(giver);
      if (!pending || pending.timer !== timer) {
        return;
      }
      this.crownTransferPending.delete(giver);
      this.notifyPlayerSystemMessage(pending.from, `发给 ${this.names[giver]} 的主城转让请求已超时。`);
    }, CROWN_TRANSFER_REQUEST_TTL_MS);
    this.crownTransferPending.set(giver, { from: requester, x, y, timer });
    this.crownTransferRequest(this.playerSids[giver], { x, y, from: this.names[requester] });
    this.notifyPlayerSystemMessage(requester, `已向 ${this.names[giver]} 发送主城转让请求，等待对方确认。`);
  }

  /** 拥有者答复转让请求：接受时重新校验全部条件（目标可能已易主/对局已结束）。 */
  replyCrownTransfer(sid: string, accept: boolean): void {
    const giver = this.playerSidToIndex.get(sid);
    if (typeof giver === 'undefined') {
      return;
    }
    const pending = this.crownTransferPending.get(giver);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.crownTransferPending.delete(giver);
    const requester = pending.from;
    if (!accept) {
      this.notifyPlayerSystemMessage(requester, `${this.names[giver]} 拒绝了你的主城转让请求。`);
      return;
    }
    if (!this.applyCrownTransfer(requester, pending.x, pending.y)) {
      this.notifyPlayerSystemMessage(requester, '主城转让失败：目标主城已易主或不再满足转让条件。');
      return;
    }
    this.replayTurnTransfers[requester].set(this.turn + 1, { x: pending.x, y: pending.y });
    this.sendSystemMessage(`${this.names[giver]} 将一座主城转让给了队友 ${this.names[requester]}。`);
    this.scheduleImmediateTick();
  }

  private applyAfkSurrender(nowMs: number): void {
    if (!this.enableAfkSurrender) {
      return;
    }
    for (let p = 0; p < this.playerSids.length; p += 1) {
      // 掉线宽限期内的玩家不参与 AFK 判定（由 expireDisconnect 单独处理超时）。
      if (this.team[p] === 0 || this.pstat[p] === LEFT_GAME || this.disconnectedAt[p] !== null) {
        continue;
      }
      const idleTurns = this.turn - this.afkLastMoveTurn[p];
      const idleMs = nowMs - this.afkLastMoveAt[p];
      if (idleTurns < AFK_MIN_TURNS || idleMs < AFK_MIN_MS) {
        continue;
      }
      if (!this.applySurrenderByIndex(p, 'afk')) {
        continue;
      }
      this.sendSystemMessage(`${this.names[p]} 因挂机自动投降并转为观战。`);
    }
  }

  /**
   * 投降 = 立即放弃所有控制权：
   * - 若队伍内还有其他存活成员，全部领土（含兵力）转移给编号最小的存活队友，
   *   主城降级为指挥所（哨所）；
   * - 否则（FFA 或队伍已无其他存活成员），主城与所有指挥所被拆除为普通空地，
   *   领土减半后打入孤军，进入自然衰减流程。
   */
  private applySurrenderByIndex(playerIndex: number, cause: GameDisciplineCause): boolean {
    if (this.pstat[playerIndex] === LEFT_GAME) {
      return false;
    }
    this.replayTurnSurrenders[playerIndex].add(this.turn + 1);
    const heir = this.findSurrenderHeir(playerIndex);
    if (heir >= 0) {
      this.transferEmpire(playerIndex + 1, heir + 1);
    } else {
      this.teardownEmpire(playerIndex + 1);
    }
    this.markEliminated(playerIndex);
    this.recentKills[this.md5(this.playerSids[playerIndex])] =
      cause === 'afk' || cause === 'disconnect_timeout' ? '挂机' : '投降';
    this.pmove[playerIndex] = [];
    this.disciplineEvent({
      gameId: this.gid,
      username: this.names[playerIndex],
      cause,
      turn: this.turn,
      elapsedMs: Date.now() - this.startAt,
      occurredAt: Date.now(),
      playerCount: this.playerSids.length,
    });
    return true;
  }

  private findSurrenderHeir(playerIndex: number): number {
    const teamId = this.team[playerIndex];
    for (let p = 0; p < this.playerSids.length; p += 1) {
      if (p !== playerIndex && this.team[p] === teamId && this.pstat[p] !== LEFT_GAME) {
        return p;
      }
    }
    return -1;
  }

  private transferEmpire(fromOwner: number, toOwner: number): void {
    for (let i = 0; i < this.n; i += 1) {
      for (let j = 0; j < this.m; j += 1) {
        if (this.owner[i][j] !== fromOwner) {
          continue;
        }
        this.owner[i][j] = toOwner;
        if (this.gridType[i][j] === -2) {
          this.gridType[i][j] = -1;
        }
      }
    }
  }

  private scheduleImmediateTick(): void {
    if (!this.tickTimer) {
      return;
    }
    clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => {
      void this.tickOnce();
    }, 10);
  }

  private async saveHistory(): Promise<string> {
    const replayId = await this.replayStore.saveReplay(
      {
        version: 'ops-v1',
        meta: this.replayMeta,
        total_turns: this.turn,
        player_ops: this.buildReplayPlayerOps(),
      },
      {
        rank: this.buildFinalRank(),
        teams: this.buildFinalRankTeams(),
        turn: Math.floor(this.turn / 2),
      },
    );
    return replayId;
  }

  private finishGame(endMessage?: string): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    // 对局结束：作废所有待确认的主城转让请求。
    for (const pending of this.crownTransferPending.values()) {
      clearTimeout(pending.timer);
    }
    this.crownTransferPending.clear();

    if (endMessage) {
      this.sendSystemMessage(endMessage);
    } else {
      let winners = '';
      for (let p = 0; p < this.playerSids.length; p += 1) {
        if (this.pstat[p] !== LEFT_GAME) {
          winners += winners.length > 0 ? `,${this.names[p]}` : this.names[p];
        }
      }
      if (winners.length > 0) {
        this.sendSystemMessage(`${winners} 获胜。`);
      } else {
        this.sendSystemMessage('本局结束，无人获胜。');
      }
    }
    this.endGame(this.gid, this.buildGameResult());
  }

  /**
   * 部署更新宽限期清算：立即停表，以当前战况按正常终局路径结束对局——
   * sendMap(true) 广播终局帧并存档回放（名次取 buildFinalRank 当前排行榜），
   * finishGame 经 endGame 回调完成 rating 结算与房间清理。幂等。
   */
  async forceFinish(endMessage: string): Promise<void> {
    if (this.finished || !this.tickTimer) {
      return;
    }
    clearTimeout(this.tickTimer);
    this.tickTimer = null;
    await this.sendMap(true);
    // 期间若有在途 Tick 已自然终局，finishGame 内的 finished 守卫保证只结算一次。
    this.finishGame(endMessage);
  }
}

export type { Move, QueuedOp, QueuedOpKind };
