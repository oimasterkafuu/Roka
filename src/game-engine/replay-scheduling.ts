import { MOVE_DX, MOVE_DY } from '../map/map-core';
import type { ReplayActionData, ReplayExecutedOp } from '../types';

const buildScheduledReplayActions = (replay: ReplayActionData, rows: number, cols: number) => {
  if (
    !Number.isSafeInteger(replay.total_turns) ||
    replay.total_turns < 0 ||
    !Array.isArray(replay.player_ops) ||
    replay.player_ops.length !== replay.meta.player_names.length ||
    replay.player_ops.length !== replay.meta.player_teams.length
  ) {
    throw new Error('回放不兼容：无效的回合数或玩家操作流。');
  }
  const scheduledBatches = replay.player_ops.map(() => new Map<number, ReplayExecutedOp[]>());
  const scheduledSurrenders = replay.player_ops.map(() => new Set<number>());
  const onMap = (x: number, y: number) =>
    Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < rows && y >= 0 && y < cols;

  for (const [player, ops] of replay.player_ops.entries()) {
    let turn = 1;
    let selected: [number, number] | null = null;
    const invalid = () => new Error(`回放不兼容：玩家 ${player + 1} 在 Tick ${turn} 的操作无效。`);
    const batch = (actions: ReplayExecutedOp[]) => {
      if (!Array.isArray(actions) || !actions.length) throw invalid();
      if (!replay.meta.multi_line && actions.length > 1) {
        throw new Error('Single-line replay contains multiple actions in one tick.');
      }
      for (const action of actions) {
        if (!action || !onMap(action.x, action.y)) throw invalid();
        if (action.kind === 'm') {
          if (!onMap(action.dx, action.dy) || ![0, 1, 2].includes(action.mode)) throw invalid();
        } else if (action.kind !== 'b' && action.kind !== 'c') throw invalid();
      }
      scheduledBatches[player].set(turn++, actions);
    };

    if (!Array.isArray(ops)) throw invalid();
    for (const op of ops) {
      if (!op || turn > replay.total_turns) throw invalid();
      switch (op.op) {
        case 'w':
          if (!Number.isSafeInteger(op.n) || op.n < 1 || op.n > replay.total_turns - turn + 1)
            throw invalid();
          turn += op.n;
          break;
        case 's':
          if (!onMap(op.x, op.y)) throw invalid();
          selected = [op.x, op.y];
          break;
        case 'r':
          scheduledSurrenders[player].add(turn++);
          selected = null;
          break;
        case 'q':
          batch(op.actions);
          selected = null;
          break;
        case 'b':
        case 'c':
          if (!selected) throw invalid();
          batch([{ kind: op.op, x: selected[0], y: selected[1] }]);
          break;
        case 'm': {
          if (
            !selected ||
            !Number.isInteger(op.d) ||
            op.d < 0 ||
            op.d >= MOVE_DX.length ||
            (op.a !== undefined && op.a !== 1) ||
            (op.h !== undefined && op.h !== 1) ||
            (op.a && op.h)
          )
            throw invalid();
          const [x, y]: [number, number] = selected;
          const dx: number = x + MOVE_DX[op.d];
          const dy: number = y + MOVE_DY[op.d];
          batch([{ kind: 'm', x, y, dx, dy, mode: op.a ? 2 : op.h ? 1 : 0 }]);
          selected = [dx, dy];
          break;
        }
        default:
          throw invalid();
      }
    }
  }
  return { scheduledBatches, scheduledSurrenders };
};

export { buildScheduledReplayActions };
