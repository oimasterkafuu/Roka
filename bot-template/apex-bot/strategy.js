'use strict';
const { project } = require('./bot/board.cjs');
const { createController } = require('./bot/controller.cjs');
function finiteArray(a, size) { return Array.isArray(a) && a.length === size && a.every(Number.isFinite); }
function applyDiff(values, target) {
  if (!Array.isArray(values) || values.length % 2) return false;
  const next = target.slice();
  for (let i = 0; i < values.length; i += 2) if (!Number.isInteger(values[i]) || values[i] < 0 || values[i] >= next.length || !Number.isFinite(values[i + 1])) return false; else next[values[i]] = values[i + 1];
  target.splice(0, target.length, ...next); return true;
}
function attachStrategy(socket, options = {}) {
  const room = String(options.room || '').trim(); if (!room) throw new Error('attachStrategy: missing room');
  const log = typeof options.log === 'function' ? options.log : () => {};
  const state = { n: 0, m: 0, size: 0, grid: [], army: [], isolated: [], fog: [], leaderboard: [], teams: new Map(), clientId: '', playerId: 0, turn: -1, inGame: false, dead: false, queue: [] };
  let controller = null, heartbeat = null, kickTimer = null, actionTimer = null;
  const onSetId = (id) => { state.clientId = String(id || ''); };
  const reset = (n, m) => { state.n = n; state.m = m; state.size = n * m; state.grid = Array(state.size).fill(200); state.army = Array(state.size).fill(0); state.isolated = Array(state.size).fill(0); state.fog = Array(state.size).fill(0); state.leaderboard = []; state.teams = new Map(); state.turn = -1; state.inGame = true; state.dead = false; state.queue = []; controller = createController(0); };
  const onInit = (data = {}) => { const n = Number(data.n), m = Number(data.m); if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < 1 || n * m > 100000) return; reset(n, m); const ids = Array.isArray(data.player_ids) ? data.player_ids.map(String) : []; state.playerId = ids.indexOf(state.clientId) + 1; controller = createController(state.playerId); log(`init_map ${n}x${m}, playerId=${state.playerId || 'spectator'}`); };
  const updateMeta = (payload) => { if (Array.isArray(payload.leaderboard)) { state.leaderboard = payload.leaderboard.map((p) => ({ ...p })); state.teams = new Map(state.leaderboard.map((p) => [Number(p.id), Number(p.team) || Number(p.id)])); const me = state.leaderboard.find((p) => Number(p.id) === state.playerId); state.dead = Boolean(me && (me.dead > 0 || me.class_ === 'dead')); } };
  const onUpdate = (payload = {}) => {
    if (!state.inGame || !Number.isInteger(payload.turn) || payload.turn < state.turn) return;
    const fields = [['grid_type', state.grid], ['army_cnt', state.army], ['isolated', state.isolated], ['fog', state.fog]];
    for (const [name, target] of fields) {
      if (payload[name] === undefined && (name === 'isolated' || name === 'fog')) {
        if (!payload.is_diff) target.fill(0);
        continue;
      }
      const ok = payload.is_diff ? applyDiff(payload[name], target) : finiteArray(payload[name], state.size);
      if (!ok) return;
      if (!payload.is_diff) target.splice(0, target.length, ...payload[name]);
    }
    updateMeta(payload); state.turn = payload.turn; if (payload.lst_move && state.queue.length) state.queue.shift();
    if (payload.kills && payload.kills[state.clientId]) state.dead = true;
    if (payload.game_end) { state.inGame = false; state.queue = []; controller?.reset(); if (actionTimer) clearTimeout(actionTimer); log(`game ended at turn ${state.turn}`); return; }
    if (!state.playerId || state.dead) return;
    if (actionTimer) clearTimeout(actionTimer); actionTimer = setTimeout(() => { const frame = project({ n: state.n, m: state.m, grid_type: state.grid, army_cnt: state.army, isolated: state.isolated, fog: state.fog, leaderboard: state.leaderboard, teams: state.teams, turn: state.turn, dead: state.dead }, state.playerId); const action = controller.choose(frame); if (action) { state.queue.push(action); socket.emit(action.kind === 'build' ? 'build' : 'attack', action); } }, Number(options.actionDelayMs || 0));
  };
  const onRoomUpdate = (data = {}) => { if (options.autoReady === false || state.inGame) return; const me = (data.players || []).find((p) => String(p.sid || p.client_id || '') === state.clientId); if (me && !me.ready) socket.emit('change_ready', { ready: true }); };
  const onConnect = () => socket.emit('join_game_room', { room });
  const onDisconnect = () => { state.inGame = false; if (actionTimer) clearTimeout(actionTimer); };
  const onLeft = () => { state.inGame = false; state.queue = []; controller?.reset(); };
  const onKick = () => { state.inGame = false; if (kickTimer) clearTimeout(kickTimer); kickTimer = setTimeout(() => socket.emit('join_game_room', { room }), 500); };
  socket.on('connect', onConnect); socket.on('disconnect', onDisconnect); socket.on('set_id', onSetId); socket.on('init_map', onInit); socket.on('update', onUpdate); socket.on('room_update', onRoomUpdate); socket.on('left', onLeft); socket.on('room_kick', onKick);
  const heartbeatMs = Math.max(0, Number(options.heartbeatIntervalMs ?? 30000) || 0); if (heartbeatMs) { heartbeat = setInterval(() => socket.emit('room_heartbeat'), heartbeatMs); heartbeat.unref?.(); }
  if (socket.connected) onConnect();
  return { state, stop() { if (heartbeat) clearInterval(heartbeat); if (kickTimer) clearTimeout(kickTimer); if (actionTimer) clearTimeout(actionTimer); for (const [e, fn] of [['connect', onConnect], ['disconnect', onDisconnect], ['set_id', onSetId], ['init_map', onInit], ['update', onUpdate], ['room_update', onRoomUpdate], ['left', onLeft], ['room_kick', onKick]]) socket.off(e, fn); } };
}
module.exports = { attachStrategy };
