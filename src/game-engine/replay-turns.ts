import type { QueuedOp } from '../game-engine';
import { ReplayPlayerOp } from '../types';
import { toMoveDirection } from './replay-helpers';

const cloneQueuedOp = (op: QueuedOp): QueuedOp => {
  if (op.kind === 'm') {
    return { kind: 'm', x: op.x, y: op.y, dx: op.dx, dy: op.dy, mode: op.mode };
  }
  return { kind: op.kind, x: op.x, y: op.y };
};

const buildTurnMoves = (lastMoves: Array<QueuedOp | null>): Array<QueuedOp | null> => {
  const turnMoves: Array<QueuedOp | null> = [];
  for (let p = 0; p < lastMoves.length; p += 1) {
    const op = lastMoves[p];
    if (!op || (op.kind === 'm' && op.x === -1)) {
      turnMoves.push(null);
    } else {
      turnMoves.push(cloneQueuedOp(op));
    }
  }
  return turnMoves;
};

const buildReplayPlayerOps = (
  playerCount: number,
  replayTurnMoves: Array<Array<QueuedOp | null>>,
  replayTurnSurrenders: Array<Set<number>>,
): ReplayPlayerOp[][] => {
  const playerOps: ReplayPlayerOp[][] = Array.from({ length: playerCount }, () => []);

  for (let p = 0; p < playerCount; p += 1) {
    const ops: ReplayPlayerOp[] = [];
    let wait = 0;
    let selected: [number, number] | null = null;

    for (let t = 0; t < replayTurnMoves.length; t += 1) {
      const turn = t + 1;
      const surrendered = replayTurnSurrenders[p].has(turn);
      const turnOp = replayTurnMoves[t][p];
      if (!turnOp && !surrendered) {
        wait += 1;
        continue;
      }

      if (wait > 0) {
        ops.push({ op: 'w', n: wait });
        wait = 0;
      }

      if (surrendered) {
        ops.push({ op: 'r' });
        selected = null;
        continue;
      }

      if (!turnOp) {
        continue;
      }

      if (!selected || selected[0] !== turnOp.x || selected[1] !== turnOp.y) {
        ops.push({ op: 's', x: turnOp.x, y: turnOp.y });
        selected = [turnOp.x, turnOp.y];
      }

      if (turnOp.kind !== 'm') {
        ops.push(turnOp.kind === 'b' ? { op: 'b' } : { op: 'c' });
        continue;
      }

      const dir = toMoveDirection(turnOp.x, turnOp.y, turnOp.dx, turnOp.dy);
      if (dir === null) {
        continue;
      }

      if (turnOp.mode === 2) {
        ops.push({ op: 'm', d: dir, a: 1 });
      } else {
        ops.push(turnOp.mode === 1 ? { op: 'm', d: dir, h: 1 } : { op: 'm', d: dir });
      }
      selected = [turnOp.dx, turnOp.dy];
    }

    if (wait > 0) {
      ops.push({ op: 'w', n: wait });
    }

    playerOps[p] = ops;
  }

  return playerOps;
};

export { buildReplayPlayerOps, buildTurnMoves };
