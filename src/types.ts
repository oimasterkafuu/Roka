export const MAX_TEAMS = 16;

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
  /** 迷雾远征开关：开启后玩家仅可见己方队伍视野范围内的归属与兵力。 */
  fog: boolean;
  /** 多线争锋开关：开启后每名玩家维护多条战线队列，每 Tick 轮转调度。 */
  multi_line: boolean;
  map_token: string;
  /** 种子来源：true = 房主自定义（对局结束后保留沿用）；false/缺省 = 随机生成（每局重随机）。 */
  map_token_custom?: boolean;
  map_mode: 'random' | 'maze' | 'archipelago' | 'mediterranean' | 'huaxia';
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
  /** 托管 Bot 启动时的组队许可：false 的房间禁止开启组队（change_game_conf 校验）。 */
  serverBotAllowTeam?: boolean;
  /** 托管 Bot 启动时的迷雾许可：false 的房间禁止开启迷雾（change_game_conf 校验）。 */
  serverBotAllowFog?: boolean;
  /** 托管 Bot 启动时的多线争锋许可：false 的房间禁止开启多线争锋（change_game_conf 校验）。 */
  serverBotAllowMultiLine?: boolean;
  /** 任意 Bot 成员（第三方 bot 令牌或服务端托管）：未允许时禁用迷雾远征。 */
  bot?: boolean;
}

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
  /** 迷雾远征开关（房间设置同步给前端展示）。 */
  fog: boolean;
  /** 多线争锋开关（房间设置同步给前端展示）。 */
  multi_line: boolean;
  map_token: string;
  /** 当前种子是否为房主自定义（自定义种子沿用不重随机，前端据此显示提示）。 */
  map_token_custom: boolean;
  map_mode: 'random' | 'maze' | 'archipelago' | 'mediterranean' | 'huaxia';
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
   * 迷雾远征扁平数组（1 = 视野外迷雾格），仅迷雾开启的实时对局下发；
   * diff 帧中与 grid_type 一样以 [index, value] 对编码。回放不含此字段。
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
  initial: ReplayFrame;
  patches: ReplayPatch[];
  meta?: ReplayMeta;
}

export interface GameConfig extends LobbyConfig {
  player_names: string[];
  player_teams: number[];
  map_size_version?: 1 | 2;
  /** 仅供回放重建选择历史规则；实时对局始终启用。 */
  auto_crown_transfer?: boolean;
}

export interface ReplayMeta {
  width_ratio: number;
  height_ratio: number;
  city_ratio: number;
  mountain_ratio: number;
  swamp_ratio: number;
  speed: number;
  allow_team: boolean;
  /** 新回放启用推兵自动转属；旧回放缺省时沿用原推兵语义。 */
  auto_crown_transfer?: boolean;
  /** 对局是否开启迷雾远征（仅作元信息记录；回放始终全视野）。 */
  fog?: boolean;
  /** 对局是否开启多线争锋（仅作元信息记录；回放操作流与单线局同构）。 */
  multi_line?: boolean;
  map_token: string;
  map_mode: 'random' | 'maze' | 'archipelago' | 'mediterranean' | 'huaxia';
  /** 新回放写入地区；旧回放缺省时按汉重建。 */
  map_region?: MapRegion;
  player_names: string[];
  player_teams: number[];
  map_size_version?: 1 | 2;
  /** 对局是否使用大地图（仅作元信息记录；实际尺寸由 width/height_ratio 编码）。 */
  map_size?: 'normal' | 'large';
}

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

export type ReplayMoveDirection = 0 | 1 | 2 | 3;

export interface ReplayPlayerOpSelect {
  op: 's';
  x: number;
  y: number;
}

export interface ReplayPlayerOpMove {
  op: 'm';
  d: ReplayMoveDirection;
  h?: 1;
  a?: 1;
}

export interface ReplayPlayerOpBuild {
  op: 'b';
}

export interface ReplayPlayerOpUpgrade {
  op: 'c';
}

export interface ReplayPlayerOpWait {
  op: 'w';
  n: number;
}

export interface ReplayPlayerOpSurrender {
  op: 'r';
}

/** 历史 ops-v1 显式主城转让记录；新对局不再写入。 */
export interface ReplayPlayerOpCrownTransfer {
  op: 't';
  x: number;
  y: number;
}

export type ReplayPlayerOp =
  | ReplayPlayerOpSelect
  | ReplayPlayerOpMove
  | ReplayPlayerOpBuild
  | ReplayPlayerOpUpgrade
  | ReplayPlayerOpWait
  | ReplayPlayerOpSurrender
  | ReplayPlayerOpCrownTransfer;

export interface ReplayActionData {
  version: 'ops-v1';
  meta: ReplayMeta;
  total_turns: number;
  player_ops: ReplayPlayerOp[][];
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
  id: string;
  author: string;
  text: string;
  time: number;
  likes: string[];
  comments: FeedComment[];
  /** 正文中解析出的 @提及（原文大小写，去重）；旧数据无此字段。 */
  mentions?: string[];
}
