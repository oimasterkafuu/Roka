import type { FogMode, ReplayTeamVision } from '../types';
import { FOG_BUILDING_VISION_RADIUS, FOG_VISION_RADIUS } from './constants';
import type { BoardState, FlatMapArrays } from './map-encoding';

export type VisionSnapshot = FlatMapArrays & { fog: number[] | null };

type VisibilityInput = Pick<BoardState, 'n' | 'm' | 'gridType' | 'owner' | 'isolated'>;

const buildingCode = (tile: number, owner: number): number => {
  if (owner <= 0) return 0;
  if (tile === -1) return owner + 50;
  if (tile === -2) return owner + 100;
  return 0;
};

export function computeTeamVisibility(
  { n: rows, m: cols, gridType, owner, isolated }: VisibilityInput,
  playerTeams: readonly number[],
  masks: ReadonlyMap<number, Uint8Array>,
): void {
  for (const visible of masks.values()) visible.fill(0);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const ownerId = owner[row][col];
      if (ownerId <= 0) continue;
      const visible = masks.get(playerTeams[ownerId - 1]);
      if (!visible) continue;
      if (isolated[row][col]) {
        visible[row * cols + col] = 1;
        continue;
      }
      const radius =
        gridType[row][col] === -1 || gridType[row][col] === -2
          ? FOG_BUILDING_VISION_RADIUS
          : FOG_VISION_RADIUS;
      const left = Math.max(0, col - radius);
      const right = Math.min(cols, col + radius + 1);
      for (let x = Math.max(0, row - radius); x <= Math.min(rows - 1, row + radius); x += 1) {
        visible.fill(1, x * cols + left, x * cols + right);
      }
    }
  }
}

export class FogVision {
  private readonly visible = new Map<number, Uint8Array>();
  private readonly exploration = new Map<number, Uint32Array>();
  private readonly buildingMemory = new Map<number, Uint8Array>();
  private readonly snapshots = new Map<number, VisionSnapshot>();
  private readonly zeroFog: number[];

  constructor(
    mode: Exclude<FogMode, 'visible'>,
    area: number,
    private readonly playerTeams: readonly number[],
  ) {
    this.zeroFog = new Array<number>(area).fill(0);
    for (const team of new Set(playerTeams)) {
      if (team <= 0) continue;
      this.visible.set(team, new Uint8Array(area));
      this.buildingMemory.set(team, new Uint8Array(area));
      if (mode === 'normal') {
        this.exploration.set(team, new Uint32Array(Math.ceil(area / 32)));
      }
    }
  }

  advance(board: VisibilityInput): void {
    this.invalidateSnapshots();
    computeTeamVisibility(board, this.playerTeams, this.visible);
    for (const [team, visible] of this.visible) {
      const remembered = this.buildingMemory.get(team)!;
      for (let row = 0; row < board.n; row += 1) {
        for (let col = 0; col < board.m; col += 1) {
          const index = row * board.m + col;
          if (visible[index]) {
            remembered[index] = buildingCode(board.gridType[row][col], board.owner[row][col]);
          }
        }
      }
    }
    for (const [team, bits] of this.exploration) {
      const visible = this.visible.get(team)!;
      for (let index = 0; index < visible.length; index += 1) {
        if (!visible[index]) continue;
        const word = index >>> 5;
        const bit = 1 << (index & 31);
        bits[word] |= bit;
      }
    }
  }

  invalidateSnapshots(): void {
    this.snapshots.clear();
  }

  snapshot(team: number, full: FlatMapArrays): VisionSnapshot {
    const visible = this.visible.get(team);
    if (!visible) return { ...full, fog: this.zeroFog };
    const cached = this.snapshots.get(team);
    if (cached) return cached;
    const explored = this.exploration.get(team);
    const remembered = this.buildingMemory.get(team)!;
    const grid_type = full.grid_type.slice();
    const army_cnt = full.army_cnt.slice();
    const isolated = full.isolated.slice();
    const fog = new Array<number>(visible.length).fill(0);
    for (let index = 0; index < visible.length; index += 1) {
      if (visible[index]) continue;
      const known = !explored || (explored[index >>> 5] & (1 << (index & 31))) !== 0;
      fog[index] = known ? 1 : 2;
      const terrain = grid_type[index];
      if (!known) grid_type[index] = 200;
      else if (remembered[index]) grid_type[index] = remembered[index];
      else if (terrain === 204 || (terrain >= 150 && terrain < 200)) grid_type[index] = 204;
      else if (terrain !== 201) grid_type[index] = 200;
      army_cnt[index] = 0;
      isolated[index] = 0;
    }
    const snapshot = { grid_type, army_cnt, isolated, fog };
    this.snapshots.set(team, snapshot);
    return snapshot;
  }

  recordTimeline(
    timeline: Map<number, ReplayTeamVision>,
    turn: number,
    isAlive: (team: number) => boolean,
  ): number {
    let added = 0;
    for (const [team, visible] of this.visible) {
      let history = timeline.get(team);
      if (!history) {
        history = { omniscientFrom: null, cells: new Map(), buildings: new Map() };
        timeline.set(team, history);
      }
      if (history.omniscientFrom !== null) continue;
      if (!isAlive(team)) {
        history.omniscientFrom = turn;
        continue;
      }
      for (let index = 0; index < visible.length; index += 1) {
        if (visible[index]) {
          const code = this.buildingMemory.get(team)[index];
          const remembered = history.buildings.get(index);
          if ((remembered?.at(-1) ?? 0) !== code) {
            if (remembered) remembered.push(turn, code);
            else history.buildings.set(index, [turn, code]);
            added += remembered ? 32 : 192;
          }
        }
        const changes = history.cells.get(index);
        if (visible[index] === ((changes?.length ?? 0) & 1)) continue;
        if (changes) changes.push(turn);
        else history.cells.set(index, [turn]);
        added += changes ? 16 : 176;
      }
    }
    return added;
  }
}
