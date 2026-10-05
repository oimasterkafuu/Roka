import { MOVE_DX, MOVE_DY } from '../map/map-core';
import { MoveMode, ReplayActionData, ReplayMoveDirection } from '../types';

type Move = [number, number, number, number, MoveMode];

interface ScheduledBuild {
  kind: 'b' | 'c';
  x: number;
  y: number;
}

interface ScheduledReplayActions {
  scheduledMoves: Array<Map<number, Move>>;
  scheduledBuilds: Array<Map<number, ScheduledBuild>>;
  scheduledSurrenders: Array<Set<number>>;
  scheduledTransfers: Array<Map<number, { x: number; y: number }>>;
}

const buildScheduledReplayActions = (replay: ReplayActionData): ScheduledReplayActions => {
  const scheduledMoves = replay.player_ops.map(() => new Map<number, Move>());
  const scheduledBuilds = replay.player_ops.map(() => new Map<number, ScheduledBuild>());
  const scheduledSurrenders = replay.player_ops.map(() => new Set<number>());
  const scheduledTransfers = replay.player_ops.map(() => new Map<number, { x: number; y: number }>());

  for (let p = 0; p < replay.player_ops.length; p += 1) {
    const ops = replay.player_ops[p];
    let cursorTurn = 1;
    let selected: [number, number] | null = null;

    for (const op of ops) {
      if (op.op === 'w') {
        cursorTurn += Math.max(0, op.n);
        continue;
      }
      if (op.op === 's') {
        selected = [op.x, op.y];
        continue;
      }
      if (op.op === 'r') {
        scheduledSurrenders[p].add(cursorTurn);
        selected = null;
        cursorTurn += 1;
        continue;
      }
      // 主城转让（issue #81）：自带目标坐标，不经过 selected。
      if (op.op === 't') {
        scheduledTransfers[p].set(cursorTurn, { x: op.x, y: op.y });
        cursorTurn += 1;
        continue;
      }
      if (!selected) {
        continue;
      }
      if (op.op === 'b' || op.op === 'c') {
        scheduledBuilds[p].set(cursorTurn, { kind: op.op, x: selected[0], y: selected[1] });
        cursorTurn += 1;
        continue;
      }

      const dir = op.d as ReplayMoveDirection;
      const dx = selected[0] + MOVE_DX[dir];
      const dy = selected[1] + MOVE_DY[dir];
      const mode: MoveMode = op.a === 1 ? 2 : op.h === 1 ? 1 : 0;
      scheduledMoves[p].set(cursorTurn, [selected[0], selected[1], dx, dy, mode]);
      selected = [dx, dy];
      cursorTurn += 1;
    }
  }

  return {
    scheduledMoves,
    scheduledBuilds,
    scheduledSurrenders,
    scheduledTransfers,
  };
};

export { buildScheduledReplayActions };
export type { ScheduledBuild };
