'use strict';
class BoardState {
  constructor(init, clientId) {
    const { n, m } = init;
    if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || n * m > 100000) throw new Error('地图尺寸无效');
    this.n = n; this.m = m;
    this.multiLine = init.multi_line === true;
    this.nextSeq = Number.isInteger(init.next_seq) && init.next_seq > 0 ? init.next_seq : 1;
    this.queue = Array.isArray(init.queue_ops) ? init.queue_ops.map(op => ({ ...op })) : [];
    this.nextSeq = Math.max(this.nextSeq, ...this.queue.map(op => op.seq + 1));
    this.playerId = (init.player_ids || []).indexOf(clientId) + 1;
    this.grid = Array(n * m).fill(202);
    this.army = Array(n * m).fill(0);
    this.isolated = Array(n * m).fill(0);
    this.fog = Array(n * m).fill(1);
    this.teams = new Map(); this.turn = -1; this.ended = false; this.dead = false;
  }
  enqueue(action) {
    const op = action.kind === 'attack'
      ? { kind: 'm', x: action.x, y: action.y, dx: action.dx, dy: action.dy, mode: action.mode ?? 0 }
      : { kind: action.op ?? 'b', x: action.x, y: action.y };
    this.queue.push({ ...op, seq: this.nextSeq++ });
  }
  apply(payload) {
    if (!Number.isInteger(payload.turn) || payload.turn < this.turn) return false;
    const fields = { grid_type: 'grid', army_cnt: 'army', isolated: 'isolated', fog: 'fog' };
    const updates = {};
    for (const [key, name] of Object.entries(fields)) {
      const values = payload[key];
      if (values === undefined && (key === 'fog' || key === 'isolated')) continue;
      if (!Array.isArray(values) || !values.every(Number.isFinite)) return false;
      if (payload.is_diff) {
        if (values.length % 2) return false;
        const next = this[name].slice();
        for (let i = 0; i < values.length; i += 2) {
          if (!Number.isInteger(values[i]) || values[i] < 0 || values[i] >= next.length) return false;
          next[values[i]] = values[i + 1];
        }
        updates[name] = next;
      } else {
        if (values.length !== this.n * this.m) return false;
        updates[name] = values.slice();
      }
    }
    Object.assign(this, updates);
    if (!payload.is_diff && payload.fog === undefined) this.fog.fill(0);
    this.turn = payload.turn;
    const removed = new Set(Array.isArray(payload.lst_moves) ? payload.lst_moves : []);
    // Receipts acknowledge removal, never execution. Keep every unacknowledged chain.
    this.removedOps = this.queue.filter(op => removed.has(op.seq));
    this.queue = this.queue.filter(op => !removed.has(op.seq));
    this.lastMove = { seqs: [...removed], turn: payload.turn };
    this.ended = Boolean(payload.game_end);
    if (Array.isArray(payload.leaderboard)) {
      this.leaderboard = payload.leaderboard.map((p) => ({ ...p }));
      this.teams = new Map(payload.leaderboard.map((p) => [Number(p.id), Number(p.team)]));
      const self = payload.leaderboard.find((p) => Number(p.id) === this.playerId);
      this.dead = Boolean(self && (self.dead > 0 || self.class_ === 'dead'));
    }
    return true;
  }
}
module.exports = { BoardState };
