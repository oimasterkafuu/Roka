/**
 * simple-strategy-bot 策略核心（与服务端内嵌运行共用的唯一实现）。
 *
 * 本文件是纯逻辑模块，不自己创建连接：调用方（CLI 的 index.js 或服务端
 * src/server/server-bot-manager.ts）传入一个已配置鉴权的 socket.io-client
 * 实例，本模块负责房间循环（进房/自动准备/对局结束后再准备）、状态维护
 * （diff 合并、队列镜像、队伍与出局者跟踪）与每 tick 的决策管线编排。
 *
 * 决策管线（每个 tick 重算，bot/ 下各模块为纯函数层）：
 *   1. defense.evaluateThreats：对每个成规模的活敌 blob 用 Dijkstra 推演
 *      进攻我方锚点代价最低的路径并按战斗规则逐格模拟，得到威胁清单
 *      （推算对方攻击路径）；
 *   2. defense.planDefense：威胁分「活跃（正在逼近）/静止（龟缩兵堆）」
 *      两层——只对活跃威胁集结布防、冻结经济与暂缓新进攻，静止威胁只做
 *      贴脸应急与可吃即切；守不住时撤空或将死主城全军出击；
 *   3. rescue.planRescue：对被敌方截断的孤军区域，推演最便宜的打通走廊
 *      （重连孤军 = 领土救回 + 兵力翻倍 + 恢复产能，性价比极高）组织
 *      救援打击；可交付兵力远低于需求的块判定救不了，止损不投入；
 *   4. offense.planOffense：评估敌方主城/指挥所目标（端掉最后一座主城
 *      = 直接淘汰），用带「邻近敌军风险」代价的 Dijkstra 选更难被破解
 *      的进军路径；入口兵力不足则以入口为焦点集结（沿路己方格自动合流，
 *      多源汇集而非单点取兵），入口推兵量到路径需求 85% 即开打；
 *      行军纪律——锚点起步半兵（主力出征家里留半）、活跃威胁逼近即
 *      回防（除非斩首更快）、新打击需求不得透支机动兵力（全军 − 驻军
 *      保留）；无打击计划时转入前线突破集结：选一个集结后可突破的
 *      对峙点做输送焦点，让前线兵力朝同一方向汇集成股；
 *   5. economy.planEconomy：铺皇冠策略——皇冠每 tick +1 产兵，指挥所
 *      与普通格同速（不增产），故指挥所只是升皇冠的中间态：攒到 101
 *      兵才按「皇冠簇优先 + 二线甜区」评分建指挥所，下回合即过升级线
 *      直接升冠（b/c 连续两回合完成直建皇冠），升级不设冷却且优先于
 *      新建；活跃威胁逼近时冻结建设，差兵的待建格由输送流顺路喂养；
 *   6. logistics.expansionCandidates：mode 0 智能分兵吃中立/孤军领土
 *      （12–25 tick 抢地冲刺加权：爆发期每块普通领土每 tick +1，圈地
 *      = 产兵；爆发期同样加权；空地优先于沼泽）；logistics.flowCandidates：
 *      向集结焦点/前线输送兵力；
 *   7. 驻军保留线（board.garrisonAt）贯穿所有模块：边境格保留邻敌推兵量，
 *      咽喉格（切断会导致大片领土失联的割点）按分离区域规模与敌军距离
 *      留守——进攻/输送不得把要害抽空，只有紧急防御集结可破格；
 *   8. 全部候选按评分排序，每 tick 最多下发 MAX_OPS_PER_TURN 条（同格
 *      不重复取源），紧急防御抢占队列；本地队列镜像上限 MAX_LOCAL_QUEUE，
 *      用 lst_move 同步，避免过期指令堆积；recentMoves 记录最近数 tick
 *      的移动方向，恰好互逆的移动直接丢弃（防往返抖动）。下发建造令前
 *      会先清掉镜像中从同格出兵的旧 op（否则旧 op 先执行会把建设资金
 *      抽空）。
 */

const { buildContext } = require('./bot/board');
const { evaluateThreats, planDefense } = require('./bot/defense');
const { planRescue } = require('./bot/rescue');
const { planOffense } = require('./bot/offense');
const { planEconomy } = require('./bot/economy');
const { expansionCandidates, flowCandidates } = require('./bot/logistics');

// 本地队列镜像上限：每 Tick 服务端只执行一条队首操作，排队过多会产生大量过期指令。
const MAX_LOCAL_QUEUE = 2;
// 每回合最多下发的操作数。
const MAX_OPS_PER_TURN = 2;
// 防往返抖动窗口：与最近若干 tick 内移动互逆的非紧急 op 不下发。
const RECENT_MOVE_WINDOW = 6;

function toBoolean(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/**
 * @param {import('socket.io-client').Socket} socket 已完成鉴权配置的 socket.io-client 实例
 * @param {object} options
 * @param {string} options.room 要加入并循环对局的房间号
 * @param {number} [options.team] 组队模式下的目标队伍号（默认 1）
 * @param {boolean} [options.autoReady] 是否自动参赛并准备（默认 true）
 * @param {number} [options.actionDelayMs] 每回合决策后的发送延迟（默认 120ms）
 * @param {number} [options.heartbeatIntervalMs] 房间心跳间隔（默认 30000ms；0 关闭）
 * @param {(message: string) => void} [options.log] 日志输出（默认 console.log）
 * @returns {{ stop: () => void }} 句柄，stop() 只拆监听与定时器，不断开 socket
 */
function attachStrategy(socket, options) {
  const room = String(options.room || '').trim();
  if (!room) {
    throw new Error('attachStrategy: missing room');
  }
  const targetTeam = Math.max(1, Number.parseInt(String(options.team ?? '1'), 10) || 1);
  const autoReady = options.autoReady !== false;
  const actionDelayMs = Math.max(0, Number.parseInt(String(options.actionDelayMs ?? '120'), 10) || 0);
  const heartbeatIntervalMs = Math.max(
    0,
    Number.parseInt(String(options.heartbeatIntervalMs ?? '30000'), 10) || 0,
  );
  const log = typeof options.log === 'function' ? options.log : (message) => console.log(message);

  const state = {
    n: 0,
    m: 0,
    gridType: [],
    armyCnt: [],
    isolated: [],
    clientId: '',
    playerId: 0,
    playerIds: [],
    generals: [],
    turn: 0,
    lastTurn: -1,
    inGame: false,
    dead: false,
    queue: [],
    lastLobbyActionAt: 0,
    lastCityTurn: -1000,
    // 跨 tick 决策状态：打击计划 / 救援计划 / 集结点（防跳变）。
    plan: null,
    rescuePlan: null,
    rallyIdx: -1,
    // 最近移动方向记忆（`${from}>${to}` → tick）：防往返抖动。
    recentMoves: new Map(),
    // 争夺记忆：涉及己方的归属翻转格 → 最近翻转 tick（防止在被反复
    // 争夺的格子上连续重建指挥所白扔 50 兵）。
    contested: new Map(),
    prevCodes: null,
    // 威胁逼近记忆：(敌 owner:我锚点) → 历史最小 hops；只有 hops 在缩小
    // 的威胁才算「活跃」（触发集结与冻结经济），静止的龟缩兵堆不算。
    // threatLastActive/defenseLatch：滞留宽限与防御闩锁（详见 defense.js）。
    threatMinHops: new Map(),
    threatLastActive: new Map(),
    defenseLatch: new Map(),
    allowTeam: false,
    teamByClient: new Map(),
    teams: new Map(),
    deadPlayers: new Set(),
    planSig: '',
  };

  function resetMap(n, m) {
    state.n = n;
    state.m = m;
    state.gridType = new Array(n * m).fill(200);
    state.armyCnt = new Array(n * m).fill(0);
    state.isolated = new Array(n * m).fill(0);
    state.lastTurn = -1;
    state.queue = [];
    state.dead = false;
    state.lastCityTurn = -1000;
    state.plan = null;
    state.rescuePlan = null;
    state.rallyIdx = -1;
    state.recentMoves = new Map();
    state.contested = new Map();
    state.prevCodes = null;
    state.threatMinHops = new Map();
    state.threatLastActive = new Map();
    state.defenseLatch = new Map();
    state.deadPlayers = new Set();
    state.planSig = '';
  }

  function applyDiff(diffArray, targetArray) {
    if (!Array.isArray(diffArray)) {
      return;
    }
    for (let i = 0; i + 1 < diffArray.length; i += 2) {
      const idx = Number.parseInt(String(diffArray[i]), 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= targetArray.length) {
        continue;
      }
      targetArray[idx] = diffArray[i + 1];
    }
  }

  function applyUpdatePayload(payload) {
    if (state.n === 0 || state.m === 0) {
      return false;
    }
    if (payload && payload.is_diff) {
      applyDiff(payload.grid_type, state.gridType);
      applyDiff(payload.army_cnt, state.armyCnt);
      if (Array.isArray(payload.isolated)) {
        applyDiff(payload.isolated, state.isolated);
      }
      return true;
    }
    if (!Array.isArray(payload?.grid_type) || !Array.isArray(payload?.army_cnt)) {
      return false;
    }
    if (
      payload.grid_type.length !== state.gridType.length ||
      payload.army_cnt.length !== state.armyCnt.length
    ) {
      return false;
    }
    state.gridType = payload.grid_type.slice();
    state.armyCnt = payload.army_cnt.slice();
    state.isolated = Array.isArray(payload.isolated)
      ? payload.isolated.slice()
      : new Array(state.n * state.m).fill(0);
    return true;
  }

  // 用 lst_move 同步本地队列镜像：skip 条队首被丢弃，若本 Tick 有执行（x >= 0）再少一条。
  function syncQueue(lstMove) {
    if (!lstMove || typeof lstMove !== 'object') {
      return;
    }
    let drop = Number.parseInt(String(lstMove.skip ?? '0'), 10) || 0;
    if (Number.parseInt(String(lstMove.x ?? '-1'), 10) >= 0) {
      drop += 1;
    }
    if (drop > 0) {
      state.queue.splice(0, drop);
    }
  }

  function enqueueOp(op) {
    state.queue.push(op);
    socket.emit(op.kind === 'build' ? 'build' : 'attack', op.payload);
  }

  function describeOp(op, tag) {
    const suffix = tag ? ` [${tag}]` : '';
    if (op.kind === 'build') {
      return `build ${op.payload.op} @(${op.payload.x},${op.payload.y})${suffix}`;
    }
    return `attack (${op.payload.x},${op.payload.y})->(${op.payload.dx},${op.payload.dy}) mode=${op.payload.mode}${suffix}`;
  }

  // 两条 op 是否等价（去重队列用）：build 看格子与类型，attack 看起止格。
  function sameOp(a, b) {
    if (a.kind !== b.kind) {
      return false;
    }
    if (a.kind === 'build') {
      return a.payload.x === b.payload.x && a.payload.y === b.payload.y && a.payload.op === b.payload.op;
    }
    return (
      a.payload.x === b.payload.x &&
      a.payload.y === b.payload.y &&
      a.payload.dx === b.payload.dx &&
      a.payload.dy === b.payload.dy
    );
  }

  // 归属翻转跟踪：逐格对比上 tick 编码，凡「我丢格/我抢格」都记入
  // contested（economy 据此避开仍在拉锯的格子），顺手清理过期条目。
  function trackContested(turn) {
    if (state.prevCodes) {
      for (let idx = 0; idx < state.n * state.m; idx += 1) {
        const prev = state.prevCodes[idx];
        const cur = state.gridType[idx];
        if (prev === cur) {
          continue;
        }
        const prevOwner = prev >= 200 ? 0 : prev % 50;
        const curOwner = cur >= 200 ? 0 : cur % 50;
        if (prevOwner !== curOwner && (prevOwner === state.playerId || curOwner === state.playerId)) {
          state.contested.set(idx, turn);
        }
      }
      for (const [idx, at] of state.contested) {
        if (turn - at > 10) {
          state.contested.delete(idx);
        }
      }
    }
    state.prevCodes = state.gridType.slice();
  }

  /* ---------- 决策管线 ---------- */

  function decideTurn(turn) {
    if (state.playerId <= 0 || state.dead) {
      return;
    }
    state.turn = turn;
    trackContested(turn);
    // 清理过期的移动方向记忆。
    for (const [key, at] of state.recentMoves) {
      if (turn - at > RECENT_MOVE_WINDOW) {
        state.recentMoves.delete(key);
      }
    }

    const ctx = buildContext(state);
    const threats = evaluateThreats(ctx);
    const defense = planDefense(ctx, threats);
    state.rallyIdx = defense.rally ?? -1;
    // 进攻/经济只看「活跃威胁」（正在逼近的）：静止的龟缩兵堆既不
    // 冻结建设，也不阻止新打击计划。
    const rescue = planRescue(ctx, state);
    const offense = planOffense(ctx, state, defense.activeThreats);
    const economy = planEconomy(ctx, state, defense.activeThreats);
    // 输送焦点优先级：防御集结点（紧急：可动用咽喉守军、不受防往返限制）
    // > 救援走廊入口 > 打击入口/突破点 > 喂养待建格。
    const focus = defense.rally
      ? { idx: defense.rally, baseScore: defense.rallyScore, overrideGarrison: true, urgent: true }
      : rescue.focus || offense.focus || economy.feedTarget;

    // 计划/集结焦点变化时打一条可观测日志（变化才打，不刷屏）。
    const planSig = state.plan
      ? `strike ${ctx.tileKind(state.plan.targetIdx)} @${state.plan.targetIdx} owner=${state.plan.owner}`
      : state.rescuePlan
        ? `rescue @${state.rescuePlan.entry} need=${state.rescuePlan.required}`
        : defense.rally
          ? `rally @${defense.rally}`
          : '';
    if (planSig !== state.planSig) {
      state.planSig = planSig;
      if (planSig) {
        log(`turn ${turn}: ${planSig}`);
      }
    }

    const candidates = [
      ...defense.candidates,
      ...rescue.candidates,
      ...offense.candidates,
      ...economy.candidates,
      ...expansionCandidates(ctx, state),
      ...flowCandidates(ctx, state, focus),
    ];
    if (candidates.length === 0) {
      return;
    }
    candidates.sort((a, b) => b.score - a.score);

    const picked = [];
    const usedSources = new Set();
    let preempt = false;
    for (const cand of candidates) {
      if (picked.length >= MAX_OPS_PER_TURN) {
        break;
      }
      if (typeof cand.srcKey === 'number' && usedSources.has(cand.srcKey)) {
        continue;
      }
      // 与本地队列镜像中尚未执行的 op 完全相同的不再重复入队
      // （否则同一行军步/建造会连下两三次，白白占掉后续 tick 的执行名额）。
      if (state.queue.some((queued) => sameOp(queued, cand.op))) {
        continue;
      }
      // 防往返抖动：与最近数 tick 的移动恰好互逆的非紧急 op 不下发
      // （紧急防御/斩杀/紧急集结流不受此限——该回头时必须回头）。
      if (!cand.preempt && !cand.urgentFlow && cand.op.kind === 'attack') {
        const from = cand.op.payload.x * state.m + cand.op.payload.y;
        const to = cand.op.payload.dx * state.m + cand.op.payload.dy;
        const reverseAt = state.recentMoves.get(`${to}>${from}`);
        if (typeof reverseAt === 'number' && turn - reverseAt <= RECENT_MOVE_WINDOW) {
          continue;
        }
      }
      picked.push(cand);
      if (typeof cand.srcKey === 'number') {
        usedSources.add(cand.srcKey);
      }
      if (cand.preempt) {
        preempt = true;
      }
    }
    if (picked.length === 0) {
      return;
    }

    // 紧急操作（贴脸防卫/斩杀/撤离）或紧急威胁窗口（hops ≤ 2）抢占队列：
    // 先清掉过期指令，让防御/集结 op 下个 tick 立即执行。
    if ((preempt || defense.urgent) && state.queue.length > 0) {
      socket.emit('clear_queue');
      state.queue = [];
    }

    // 队列水位控制：本地镜像已满时本回合只下发到剩余容量。
    const accepted = [];
    for (const cand of picked) {
      if (state.queue.length + accepted.length >= MAX_LOCAL_QUEUE) {
        break;
      }
      accepted.push(cand);
    }
    if (accepted.length === 0) {
      return;
    }

    for (const cand of accepted) {
      if (cand.op.kind === 'build' && cand.op.payload.op === 'b') {
        // 只有新建指挥所占建设冷却；升级皇冠各格自负盈亏，不占冷却。
        state.lastCityTurn = turn;
      } else if (cand.op.kind === 'attack') {
        // 记录移动方向（防往返抖动）。
        const from = cand.op.payload.x * state.m + cand.op.payload.y;
        const to = cand.op.payload.dx * state.m + cand.op.payload.dy;
        state.recentMoves.set(`${from}>${to}`, turn);
      }
    }

    setTimeout(() => {
      for (const cand of accepted) {
        if (cand.op.kind === 'build') {
          // 出队占位冲突：镜像队列里若还有从该格出兵的旧 op（生成时该格
          // 还是高兵普通格），它会先执行、把建设资金抽空导致建造被引擎
          // 跳过——先把这些旧 op 从服务端队列与镜像中清掉再下建造令。
          const { x, y } = cand.op.payload;
          const kept = state.queue.filter(
            (queued) => !(queued.kind === 'attack' && queued.payload.x === x && queued.payload.y === y),
          );
          if (kept.length !== state.queue.length) {
            socket.emit('clear_queue');
            state.queue = [];
            for (const op of kept) {
              enqueueOp(op);
            }
          }
        }
        enqueueOp(cand.op);
        log(`turn ${turn}: ${describeOp(cand.op, cand.tag)}`);
      }
    }, actionDelayMs);
  }

  /* ---------- 房间循环 ---------- */

  function autoReadyFromRoomUpdate(data) {
    if (!autoReady || !state.clientId) {
      return;
    }
    if (!Array.isArray(data?.players) || toBoolean(data?.in_game)) {
      return;
    }

    const self = data.players.find((player) => String(player?.sid || '') === state.clientId);
    if (!self) {
      return;
    }

    const allowTeam = toBoolean(data.allow_team);
    const team = Number.parseInt(String(self.team ?? '0'), 10) || 0;
    const ready = toBoolean(self.ready);
    const need = Number.parseInt(String(data?.need ?? '0'), 10) || 0;
    const now = Date.now();

    if (now - state.lastLobbyActionAt < 1000) {
      return;
    }

    if (team === 0) {
      socket.emit('change_team', { team: allowTeam ? targetTeam : 1 });
      state.lastLobbyActionAt = now;
      log(`request change_team=${allowTeam ? targetTeam : 1}`);
      return;
    }

    if (need <= 1) {
      return;
    }

    if (!ready) {
      socket.emit('change_ready', { ready: true });
      state.lastLobbyActionAt = now;
      log('request change_ready=true');
    }
  }

  // 组队信息跟踪：room_update 里 players[].sid 即 md5 后的 client_id，
  // 与 init_map 的 player_ids 一一对应，据此建立 playerId → 队伍映射。
  function trackTeamsFromRoomUpdate(data) {
    if (data && typeof data === 'object' && 'allow_team' in data) {
      state.allowTeam = toBoolean(data.allow_team);
    }
    if (!Array.isArray(data?.players)) {
      return;
    }
    for (const player of data.players) {
      const sid = String(player?.sid || '');
      if (!sid) {
        continue;
      }
      state.teamByClient.set(sid, Number.parseInt(String(player?.team ?? '0'), 10) || 0);
    }
  }

  /* ---------- socket 事件 ---------- */

  const onConnect = () => {
    log(`connected: ${socket.id}`);
    socket.emit('join_game_room', { room });
  };

  const onConnectError = (error) => {
    log(`connect_error: ${error.message}`);
  };

  const onDisconnect = (reason) => {
    log(`disconnected: ${reason}`);
    state.inGame = false;
  };

  const onSetId = (id) => {
    state.clientId = String(id || '');
    log(`client_id: ${state.clientId}`);
  };

  const onInitMap = (data) => {
    const n = Number.parseInt(String(data?.n ?? '0'), 10);
    const m = Number.parseInt(String(data?.m ?? '0'), 10);
    if (!Number.isFinite(n) || !Number.isFinite(m) || n <= 0 || m <= 0) {
      return;
    }

    resetMap(n, m);
    state.inGame = true;

    const playerIds = Array.isArray(data?.player_ids) ? data.player_ids.map((item) => String(item)) : [];
    state.playerIds = playerIds;
    const foundIndex = playerIds.indexOf(state.clientId);
    state.playerId = foundIndex >= 0 ? foundIndex + 1 : 0;

    // playerId → 队伍：房间阶段收集的 teamByClient 按 player_ids 对齐；
    // 未知（如中途观战进房）时退化为自己一队（即无队友，与旧行为一致）。
    state.teams = new Map();
    for (let i = 0; i < playerIds.length; i += 1) {
      const team = state.teamByClient.get(playerIds[i]) || 0;
      state.teams.set(i + 1, team > 0 ? team : i + 1);
    }

    state.generals = [];
    if (Array.isArray(data?.general) && data.general.length === 2) {
      const gx = Number.parseInt(String(data.general[0]), 10);
      const gy = Number.parseInt(String(data.general[1]), 10);
      if (gx >= 0 && gy >= 0 && gx < n && gy < m) {
        state.generals = [{ x: gx, y: gy }];
      }
    }
    log(`init_map ${n}x${m}, playerId=${state.playerId || 'spectator'}`);
  };

  const onUpdate = (payload) => {
    if (!state.inGame) {
      return;
    }

    // kills：victim client_id → killer 名字。顺手维护出局者集合
    // （出局者领土已孤军化，进攻/防御/扩张都按无主之地理性处理）。
    if (payload?.kills && typeof payload.kills === 'object') {
      for (const victimClientId of Object.keys(payload.kills)) {
        const idx = state.playerIds.indexOf(victimClientId);
        if (idx >= 0) {
          state.deadPlayers.add(idx + 1);
        }
      }
      if (state.clientId && payload.kills[state.clientId]) {
        state.dead = true;
      }
    }

    const ok = applyUpdatePayload(payload);
    if (!ok) {
      return;
    }

    const turn = Number.parseInt(String(payload?.turn ?? '-1'), 10);
    if (!Number.isFinite(turn) || turn < 0 || turn === state.lastTurn) {
      return;
    }
    state.lastTurn = turn;
    syncQueue(payload?.lst_move);

    if (payload?.game_end) {
      state.inGame = false;
      state.plan = null;
      state.rescuePlan = null;
      log(`game ended at turn ${turn}`);
      return;
    }

    decideTurn(turn);
  };

  const onLeft = () => {
    state.inGame = false;
    state.plan = null;
    state.rescuePlan = null;
    log('left current game');
  };

  const onRoomKick = () => {
    state.inGame = false;
    state.plan = null;
    state.rescuePlan = null;
    log('kicked from room: heartbeat timeout, rejoining');
    // 被心跳踢出后延迟重新进房，保持对局循环。
    setTimeout(() => {
      socket.emit('join_game_room', { room });
    }, 1000);
  };

  const onRoomUpdate = (data) => {
    trackTeamsFromRoomUpdate(data);
    autoReadyFromRoomUpdate(data);
  };

  socket.on('connect', onConnect);
  socket.on('connect_error', onConnectError);
  socket.on('disconnect', onDisconnect);
  socket.on('set_id', onSetId);
  socket.on('init_map', onInitMap);
  socket.on('update', onUpdate);
  socket.on('left', onLeft);
  socket.on('room_kick', onRoomKick);
  socket.on('room_update', onRoomUpdate);

  // 房间心跳：普通用户 JWT 鉴权需要心跳才能长留在准备阶段；bot 令牌/服务端托管
  // 连接本就被服务端豁免，多发无害。
  let heartbeatTimer = null;
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      socket.emit('room_heartbeat');
    }, heartbeatIntervalMs);
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }
  }

  return {
    stop() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.off('disconnect', onDisconnect);
      socket.off('set_id', onSetId);
      socket.off('init_map', onInitMap);
      socket.off('update', onUpdate);
      socket.off('left', onLeft);
      socket.off('room_kick', onRoomKick);
      socket.off('room_update', onRoomUpdate);
    },
  };
}

module.exports = { attachStrategy };
