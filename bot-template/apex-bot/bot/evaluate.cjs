'use strict';
const { preview, successor, computePush } = require('./rules.cjs');
// Only for already legal generated candidates: no array copies or successor allocation.
function cheapResult(board, action) {
  if (action.kind === 'build') return { ok: true, index: board.idx(action.x, action.y) };
  const from = board.idx(action.x, action.y), to = board.idx(action.dx, action.dy);
  const send = computePush(board, from, to, action.mode);
  return { ok: send > 0, from, to, send, captured: !board.friendly(board.playerId, board.owner(to)) && send > board.army[to] };
}
const { connectedToAnchor } = require('./board.cjs');
function value(board, player = board.playerId) {
  const connected = connectedToAnchor(board, player);
  let score = 0;
  for (let i = 0; i < board.size; i++) {
    if (!board.friendly(player, board.owner(i))) continue;
    score += 8 + board.army[i] * (connected.has(i) ? 0.7 : 0.2);
    if (board.kind(i) === 'crown') score += 1800;
    if (board.kind(i) === 'city') score += 45;
    if (!connected.has(i)) score -= 12;
  }
  return score;
}
function frontierDistances(board) {
  if (board.frontierDistances) return board.frontierDistances;
  const distance = Array(board.size).fill(Infinity), queue = [];
  for (let i = 0; i < board.size; i++) if (board.own(i) && board.neighbors(i).some((j) => !board.friendly(board.playerId, board.owner(j)) && !['unknown', 'mountain'].includes(board.kind(j)))) {
    distance[i] = 0; queue.push(i);
  }
  for (let h = 0; h < queue.length; h++) for (const j of board.neighbors(queue[h])) if (board.own(j) && distance[j] > distance[queue[h]] + 1) {
    distance[j] = distance[queue[h]] + 1; queue.push(j);
  }
  board.frontierDistances = distance;
  return distance;
}
function scoreAction(board, action, result = preview(board, action)) {
  if (!result.ok) return -Infinity;
  if (action.kind === 'build') return action.op === 'c' ? 100 : board.army[result.index] >= 100 ? 45 : 14;
  let score = 0;
  const { from, to, send } = result;
  if (result.decap) return 10000;
  if (board.friendly(board.playerId, board.owner(to))) {
    const dist = frontierDistances(board);
    score = dist[to] < dist[from] ? 4 + Math.min(send, 100) * 0.1 : -15;
    // An adjacent threatened crown gets immediate reinforcement, even backwards.
    if (board.kind(to) === 'crown' && board.neighbors(to).some((j) => board.enemy(j) && board.army[j] - 1 > board.army[to])) score += 200;
  } else if (result.captured) {
    score = 18 + Math.min(send - board.army[to], 100) * 0.1;
    if (board.enemy(to)) score += 28;
    if (board.kind(to) === 'city') score += 45;
    if (board.kind(to) === 'crown') score += 1800;
    if (board.kind(to) === 'swamp') score -= 12;
  } else score = -30 - send * 0.5;
  return score;
}
function bestResponse(board, action, candidateFactory) {
  const result = preview(board, action);
  if (!result.ok) return { score: -Infinity, risk: Infinity, reply: null };
  const after = successor(board, result), baseline = value(after, board.playerId);
  let risk = 0, worstReply = null;
  const enemies = new Set();
  for (let i = 0; i < after.size; i++) if (after.enemy(i) && !after.isolated[i]) enemies.add(after.owner(i));
  for (const enemy of enemies) {
    const opponent = after.withPlayer(enemy);
    // Replies are generated on the post-action board, with enemy identity and teams.
    const replies = candidateFactory(opponent)
      .filter((a) => a.kind === 'attack' && opponent.friendly(board.playerId, opponent.owner(opponent.idx(a.dx, a.dy))))
      .map((action) => ({ action, quick: scoreAction(opponent, action, cheapResult(opponent, action)) }))
      .sort((a, b) => b.quick - a.quick).slice(0, 4);
    for (const { action: reply } of replies) {
      const rr = preview(opponent, reply);
      if (!rr.ok || reply.kind !== 'attack') continue;
      const replied = successor(opponent, rr, board.playerId);
      let loss = baseline - value(replied, board.playerId);
      if (rr.captured && (rr.to === result.from || rr.to === result.to)) loss += 25;
      if (rr.decap && opponent.owner(rr.to) === board.playerId) loss += 10000;
      if (loss > risk) { risk = loss; worstReply = { playerId: enemy, action: reply, result: rr }; }
    }
  }
  return { score: scoreAction(board, action, result) - risk, risk, reply: worstReply, result };
}
module.exports = { scoreAction, bestResponse, value, cheapResult };
