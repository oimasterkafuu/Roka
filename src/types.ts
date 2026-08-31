export const MAX_TEAMS = 16;

export type ChatScope = 'room' | 'sid';

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
  map_token: string;
  map_mode: 'random' | 'maze' | 'archipelago' | 'mediterranean';
}

export interface LobbyPlayer {
  sid: string;
  uid: string;
  team: number;
  ready: boolean;
}

export interface RoomPlayerView {
  sid: string;
  uid: string;
  team: number;
  ready: boolean;
}

export interface RoomUpdatePayload {
  speed: number;
  allow_team: boolean;
  map_token: string;
  map_mode: 'random' | 'maze' | 'archipelago' | 'mediterranean';
  in_game: boolean;
  players: RoomPlayerView[];
  ready: number;
  need: number;
}

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
}

export interface LeaderboardEntry {
  team: number;
  uid: string;
  army: number;
  land: number;
  class_: string;
  dead: number;
  id: number;
}

export interface UpdatePayload {
  grid_type: number[];
  army_cnt: number[];
  isolated: number[];
  lst_move: MovePayload;
  leaderboard: LeaderboardEntry[];
  turn: number;
  kills: Record<string, string>;
  game_end: boolean;
  is_diff: boolean;
  replay?: string;
}

export interface ReplayPatchPayload {
  grid_type: number[];
  army_cnt: number[];
  isolated: number[];
  lst_move: MovePayload;
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
  initial: UpdatePayload;
  patches: ReplayPatch[];
  meta?: ReplayMeta;
}

export interface GameConfig extends LobbyConfig {
  player_names: string[];
  player_teams: number[];
  map_size_version?: 1 | 2;
}

export interface ReplayMeta {
  width_ratio: number;
  height_ratio: number;
  city_ratio: number;
  mountain_ratio: number;
  swamp_ratio: number;
  speed: number;
  allow_team: boolean;
  map_token: string;
  map_mode: 'random' | 'maze' | 'archipelago' | 'mediterranean';
  player_names: string[];
  player_teams: number[];
  map_size_version?: 1 | 2;
}

export interface ReplayListItem {
  time: number;
  id: string;
  rank: string[];
  turn: number;
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

export type ReplayPlayerOp =
  | ReplayPlayerOpSelect
  | ReplayPlayerOpMove
  | ReplayPlayerOpBuild
  | ReplayPlayerOpUpgrade
  | ReplayPlayerOpWait
  | ReplayPlayerOpSurrender;

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
  ready: number;
  need: number;
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
}

export interface FeedPost {
  id: string;
  author: string;
  text: string;
  time: number;
  likes: string[];
  comments: FeedComment[];
}
