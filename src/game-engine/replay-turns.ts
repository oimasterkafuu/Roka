import type { QueuedOp } from '../game-engine';
import { ReplayPlayerOp } from '../types';

const buildTurnMoves = (moves: QueuedOp[][]): QueuedOp[][] =>
  moves.map((actions) => actions.map((op) => ({ ...op })));

const buildReplayPlayerOps = (
  playerCount: number,
  replayTurnMoves: QueuedOp[][][],
  replayTurnSurrenders: Array<Set<number>>,
): ReplayPlayerOp[][] =>
  Array.from({ length: playerCount }, (_, p) => {
    const ops: ReplayPlayerOp[] = [];
    let wait = 0;
    for (let t = 0; t < replayTurnMoves.length; t += 1) {
      const actions = replayTurnMoves[t][p];
      const surrendered = replayTurnSurrenders[p].has(t + 1);
      if (!actions.length && !surrendered) {
        wait += 1;
        continue;
      }
      if (wait) {
        ops.push({ op: 'w', n: wait });
        wait = 0;
      }
      if (surrendered) {
        ops.push({ op: 'r' });
      } else {
        ops.push({
          op: 'q',
          actions: actions.map((op) =>
            op.kind === 'm'
              ? { kind: op.kind, x: op.x, y: op.y, dx: op.dx, dy: op.dy, mode: op.mode }
              : { kind: op.kind, x: op.x, y: op.y },
          ),
        });
      }
    }
    if (wait) ops.push({ op: 'w', n: wait });
    return ops;
  });

export { buildReplayPlayerOps, buildTurnMoves };
