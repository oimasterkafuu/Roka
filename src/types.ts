import type { MapMode } from './map/map-core';

export const MAX_TEAMS = 16;
export const FOG_MODES = ['normal', 'explored', 'visible'] as const;
export type FogMode = (typeof FOG_MODES)[number];
export const isFogMode = (value: unknown): value is FogMode => FOG_MODES.some((mode) => mode === value);
export type AiDifficulty = 'normal' | 'simple';
export const isAiDifficulty = (value: unknown): value is AiDifficulty =>
  value === 'normal' || value === 'simple';
export const REPLAY_OPS_VERSION = 'RKL1';

export type MapRegion = 'qin' | 'han' | 'tang' | 'song' | 'yuan' | 'ming' | 'liao' | 'china' | 'taiwan';

export type ChatScope = 'room' | 'sid';

/**
 * chat_message 可选折叠负载（issue #113）：进出类系统消息（加入/离开/重连/被移出）由
 * 客户端把连续到达的消息合并显示。verb 为该消息的谓语部分（如「加入了自定义房间。」），
 * 仅用于客户端重组文案；不含此字段的系统消息不参与折叠并断开折叠链。
 */
export interface ChatFoldPayload {
  name: string;
  verb: string;
}

/**
 * 推兵模式：0 = 智能分兵（普通 WASD），1 = 半兵（Z，一次性），2 = 全冲（Shift+WASD）。
 */
export type MoveMode = 0 | 1 | 2;

/**
 * 队列操作类型：'m' = 推兵，'b' = 建造指挥所（X），'c' = 升级主城（C）。
 */
export type QueuedOpKind = 'm' | 'b' | 'c';

export interface LobbyConfig {
  width_ratio: number;
  height_ratio: number;
  city_ratio: number;
  mountain_ratio: number;
  swamp_ratio: number;
  speed: number;
  allow_team: boolean;
  fog_mode: FogMode;
  ai_difficulty: AiDifficulty;
  /** 多线争锋开关：开启后每名玩家维护多条战线队列，每 Tick 轮转调度。 */
  multi_line: boolean;
  map_token: string;
  /** 种子来源：true = 房主自定义（对局结束后保留沿用）；false/缺省 = 随机生成（每局重随机）。 */
  map_token_custom?: boolean;
  map_mode: MapMode;
  /** 华夏模式的地区；旧配置缺省时使用汉。 */
  map_region: MapRegion;
  /** 地图大小：normal 标准；large 大地图（边长约 2 倍，面积约 4 倍）。 */
  map_size: 'normal' | 'large';
}

export interface LobbyPlayer {
  sid: string;
  uid: string;
  team: number;
  ready: boolean;
  /** 服务端托管策略 Bot（管理后台启动）：进房时排在普通成员之后，不当房主。 */
  serverBot?: boolean;
  /** 托管 Bot 当前的组队许可：false 的房间禁止开启组队（change_game_conf 校验）。 */
  serverBotAllowTeam?: boolean;
  /** 托管 Bot 当前的迷雾许可：false 的房间禁止开启迷雾（change_game_conf 校验）。 */
  serverBotAllowFog?: boolean;
  /** 托管 Bot 当前的多线争锋许可：false 的房间禁止开启多线争锋（change_game_conf 校验）。 */
  serverBotAllowMultiLine?: boolean;
  /** 任意 Bot 成员（第三方 bot 令牌或服务端托管）：未允许时禁用迷雾远征。 */
  bot?: boolean;
}

export const botForbidsFog = (player: LobbyPlayer): boolean =>
  player.bot === true && (player.serverBot !== true || player.serverBotAllowFog !== true);

export interface RoomPlayerView {
  sid: string;
  uid: string;
  team: number;
  ready: boolean;
  /** 服务端托管策略 Bot（管理后台启动）标记，仅在为 true 时下发。 */
  server_bot?: boolean;
  /** Bot 成员标记（仅在为 true 时下发）。 */
  bot?: boolean;
  /** 服务端托管策略 Bot 的组队许可（仅在为 true 时下发）：前端据此判断房主是否可开关组队。 */
  server_bot_allow_team?: boolean;
  /** 服务端托管策略 Bot 的迷雾许可（仅在为 true 时下发）：前端据此判断房主是否可开关迷雾。 */
  server_bot_allow_fog?: boolean;
  /** 服务端托管策略 Bot 的多线争锋许可（仅在为 true 时下发）：前端据此判断房主是否可开关多线争锋。 */
  server_bot_allow_multi_line?: boolean;
  /** 未经真人客户端认证的对局连接标记（仅在为 true 时下发）：前端为名字加「[AI] 」前缀。 */
  ai?: boolean;
}

export interface RoomUpdatePayload {
  speed: number;
  allow_team: boolean;
  fog_mode: FogMode;
  ai_difficulty: AiDifficulty;
  /** 多线争锋开关（房间设置同步给前端展示）。 */
  multi_line: boolean;
  map_token: string;
  /** 当前种子是否为房主自定义（自定义种子沿用不重随机，前端据此显示提示）。 */
  map_token_custom: boolean;
  map_mode: MapMode;
  /** 华夏模式的地区；旧房间快照缺省时使用汉。 */
  map_region: MapRegion;
  /** 地图大小（房间设置同步给前端展示）。 */
  map_size: 'normal' | 'large';
  in_game: boolean;
  /** 部署更新排队中（禁止开新局，前端据此禁用开始按钮并显示提示）。 */
  update_queued: boolean;
  players: RoomPlayerView[];
  /** Readiness split by verified humans and AI; spectators are excluded. */
  ready_counts: {
    human: { ready: number; need: number; total: number };
    ai: { ready: number; need: number; total: number };
  };
}

/** 内部历史回放操作结构，不属于实时对外契约。 */
export interface MovePayload {
  x: number;
  y: number;
  dx: number;
  dy: number;
  half: boolean;
  mode: MoveMode;
  op: QueuedOpKind;
  /**
   * 本 Tick 被执行操作之前因失效被丢弃的队首操作数（无执行时为全部丢弃数）。
   * 客户端用它精确同步本地队列显示。
   */
  skip?: number;
  /**
   * 多线争锋对局中本 Tick 所调度战线的编号（0 起）；skip 与执行操作均属于该战线。
   * 仅多线对局下发，单线对局无此字段。
   */
  line?: number;
  seq?: number;
}

export interface LeaderboardEntry {
  team: number;
  uid: string;
  army: number;
  land: number;
  class_: string;
  dead: number;
  id: number;
  /** 未经真人客户端认证的连接（仅实时对局帧下发，回放不含）：前端为名字加「[AI] 」前缀。 */
  ai?: boolean;
}

export interface UpdatePayload {
  grid_type: number[];
  army_cnt: number[];
  isolated: number[];
  /**
   * 0 当前可见，1 视野外且已探索，2 从未探索；全部可视不下发。
   * diff 帧与 grid_type 一样以 [index, value] 对编码。
   */
  fog?: number[];
  lst_moves: number[];
  leaderboard: LeaderboardEntry[];
  turn: number;
  kills: Record<string, string>;
  game_end: boolean;
  is_diff: boolean;
  replay?: string;
}

/** 内部回放帧；历史操作字段不属于实时 socket 契约。 */
export interface ReplayFrame extends UpdatePayload {
  lst_move: MovePayload;
}

export interface ReplayPatchPayload {
  is_diff: true;
  grid_type: number[];
  army_cnt: number[];
  isolated: number[];
  lst_move?: MovePayload;
  lst_moves?: number[];
  leaderboard: LeaderboardEntry[];
  turn: number;
  kills: Record<string, string>;
  game_end: boolean;
}

export interface ReplayPatch {
  forward: ReplayPatchPayload;
  backward: ReplayPatchPayload;
}

export interface ReplayData {
  n: number;
  m: number;
  keyframes: Map<number, ReplayFrame>;
  stride: number;
  initial: ReplayFrame;
  patches: ReplayPatch[];
  meta: ReplayMeta;
  vision: Map<number, ReplayTeamVision>;
}

export interface ReplayTeamVision {
  omniscientFrom: number | null;
  cells: Map<number, number[]>;
  buildings: Map<number, number[]>;
}

export interface GameConfig extends LobbyConfig {
  player_names: string[];
  player_teams: number[];
  server_bot_seats: number[];
}

export type ReplayMeta = Pick<
  GameConfig,
  | 'width_ratio'
  | 'height_ratio'
  | 'city_ratio'
  | 'mountain_ratio'
  | 'swamp_ratio'
  | 'speed'
  | 'allow_team'
  | 'fog_mode'
  | 'ai_difficulty'
  | 'server_bot_seats'
  | 'multi_line'
  | 'map_token'
  | 'map_mode'
  | 'map_region'
  | 'player_names'
  | 'player_teams'
  | 'map_size'
>;

export interface ReplayListItem {
  time: number;
  id: string;
  rank: string[];
  turn: number;
  /**
   * 终局名次的队伍分组（组序 = 队伍名次序，组内 = 个人名次序），
   * 由 buildFinalRankTeams 在归档时写入，供回放列表组队合并展示。
   * color 为组内最小玩家 id（与回放页标题的 inline-color-block 配色一致）。
   * 旧索引项无此字段，前端回退为 rank 平铺。
   */
  teams?: { members: string[]; color: number }[];
}

export interface ReplayPlayerOpWait {
  op: 'w';
  n: number;
}

/** Successful actions in execution order; one batch consumes exactly one tick. */
export type ReplayExecutedOp =
  | { kind: 'm'; x: number; y: number; dx: number; dy: number; mode: MoveMode }
  | { kind: 'b' | 'c'; x: number; y: number };

export interface ReplayPlayerOpBatch {
  op: 'q';
  actions: ReplayExecutedOp[];
}

export type ReplayPlayerOp = ReplayPlayerOpBatch | ReplayPlayerOpWait;

export interface ReplayActionData {
  version: typeof REPLAY_OPS_VERSION;
  meta: ReplayMeta;
  total_turns: number;
  player_ops: ReplayPlayerOp[][];
  rows: number;
  cols: number;
  state_crc: number;
  /** [completed tick, zero-based seat, phase: 0=AFK inside tick, 1=manual between ticks]. */
  surrenders: Array<[number, number, number]>;
}

export interface RoomListItem {
  room: string;
  host: string;
  total: number;
  playing: number;
  spectators: number;
  ready_counts: RoomUpdatePayload['ready_counts'];
  running: boolean;
  /** 多线争锋房间标记（仅在为 true 时下发）：首页房间列表据此显示模式标识。 */
  multi_line?: boolean;
}

export interface GameResultEntry {
  uid: string;
  team: number;
  rank: number;
  server_bot?: true;
}

export interface FeedComment {
  id: string;
  author: string;
  text: string;
  time: number;
  /** 正文中解析出的 @提及（原文大小写，去重）；旧数据无此字段。 */
  mentions?: string[];
}

export interface FeedPost {
  /** 成功编辑正文的版本时间；旧数据缺省。 */
  editedAt?: number;
  id: string;
  author: string;
  text: string;
  time: number;
  likes: string[];
  comments: FeedComment[];
  /** 正文中解析出的 @提及（原文大小写，去重）；旧数据无此字段。 */
  mentions?: string[];
}
