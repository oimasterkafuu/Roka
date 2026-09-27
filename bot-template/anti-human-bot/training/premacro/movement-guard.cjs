'use strict';

// 同一局的各个决策模块共享记忆，不向 BoardState 写入任何属性。
const memories = new WeakMap();
const REVERSE_TICKS = 4;
const PATH_STEPS = 6;
const owner = v => v >= 1 && v <= 49 ? v :
  v >= 51 && v <= 99 ? v - 50 :
    v >= 101 && v <= 149 ? v - 100 :
      v >= 151 && v <= 199 ? v - 150 : 0;

function createMovementGuard(state) {
  const validState = state !== null && typeof state === 'object';
  let memory = validState && memories.get(state);
  if (!memory) {
    memory = { turn: null, receiptTurn: -1, history: [], pending: null, blockedEdges: new Set() };
    if (validState) memories.set(state, memory);
  }
  const coordinates = action => {
    if (!action || !validState || !Number.isInteger(state.n) || !Number.isInteger(state.m) ||
        state.n < 1 || state.m < 1) return null;
    const { x, y, dx, dy } = action;
    if (![x, y, dx, dy].every(Number.isInteger) || x < 0 || dx < 0 ||
        y < 0 || dy < 0 || x >= state.n || dx >= state.n || y >= state.m || dy >= state.m) return null;
    const from = x * state.m + y, to = dx * state.m + dy;
    return from === to ? null : { from, to };
  };
  const own = i => Number.isInteger(state.playerId) && state.playerId > 0 &&
    state.playerId <= 49 && owner(state.grid?.[i]) === state.playerId && !state.fog?.[i];
  const transport = edge => own(edge.from) && own(edge.to);

  function sync() {
    const turn = validState && state.turn;
    memory.blockedEdges.clear();
    if (!Number.isInteger(turn) || turn < 0) return;
    if (memory.turn !== null && turn < memory.turn) {
      memory.history = [];
      memory.pending = null;
      memory.receiptTurn = -1;
    }
    memory.turn = turn;
    // 曾经失去所有权的边不再作为境内运输证据（包括后来夺回）。
    memory.history = memory.history.map(edge => edge.break || transport(edge) ? edge :
      { from: -1, to: -1, turn: edge.turn, break: true });
    const receipt = state.lastMove;
    if (receipt && Number.isInteger(receipt.turn) && receipt.turn >= 0 &&
        receipt.turn <= turn && receipt.turn > memory.receiptTurn) {
      memory.receiptTurn = receipt.turn;
      const edge = receipt.op === 'm' && coordinates(receipt);
      // 未知、未执行、建造回执均不能把 pending 变成一次已执行移动。
      if (edge && transport(edge)) {
        memory.history.push({ ...edge, turn: receipt.turn });
        memory.history = memory.history.slice(-PATH_STEPS);
      } else {
        // 非运输行动打断连续运输路径，但不撤销近期反向边。
        memory.history.push({ from: -1, to: -1, turn: receipt.turn, break: true });
        memory.history = memory.history.slice(-PATH_STEPS);
      }
      memory.pending = null;
    }
    for (const edge of memory.history) {
      if (!edge.break && turn - edge.turn <= REVERSE_TICKS && transport(edge))
        memory.blockedEdges.add(`${edge.to}:${edge.from}`);
    }
  }

  function closesCycle(edge) {
    let cursor = edge.from;
    // 只沿最近的连续实际运输路径回溯，不把不相关部队的边拼成图环。
    for (let i = memory.history.length - 1, steps = 0; i >= 0; i--) {
      const previous = memory.history[i];
      if (previous.break || previous.to !== cursor || !transport(previous)) break;
      cursor = previous.from;
      steps++;
      // 一步回退由 4tick 规则负责；短环仅指至少三条边的闭环。
      if (steps >= 2 && cursor === edge.to) return true;
    }
    return false;
  }

  const guard = {
    accept(action, { emergency = false } = {}) {
      sync();
      if (!action) return false;
      if (action.kind === 'build' || (action.op && action.op !== 'm')) return true;
      const edge = coordinates(action);
      if (!edge) return false;
      if (!transport(edge)) return true;
      // 此标志只由调用方的紧急逃生/救城分支设置，不根据 reason 猜测。
      // 放行不清空历史，紧急移动的实际回执仍按普通移动登记。
      if (emergency === true) return true;
      return !memory.blockedEdges.has(`${edge.from}:${edge.to}`) && !closesCycle(edge);
    },
    finish(action) {
      sync();
      const edge = coordinates(action);
      memory.pending = edge ? { ...edge, turn: memory.turn } : null;
    },
    get blockedEdges() {
      sync();
      return memory.blockedEdges;
    }
  };
  sync();
  return guard;
}

module.exports = { createMovementGuard };
