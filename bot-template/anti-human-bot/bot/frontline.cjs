'use strict';

// 边界进攻评估：只回答「这一步打下去，下几个 tick 会不会亏」。
// 与旧版的关键差别：
//   1. 不再使用「2 跳内敌军全额」「全图敌军总量」这类聚合门槛；
//   2. 敌方 2 跳兵力按到达时间衰减（默认 0.45），相邻兵力才按全额算；
//   3. 目标格本 tick 可能得到的同 tick 增援按可动兵折算；
//   4. 攻城/攻冠/碾压三种情况允许「交换」，不再要求纯赚；
//   5. 不再存在「前沿两格内没有自家建筑就一律不许深入」的 deep 规则。
const { createContext } = require('./threat.cjs');
const { resolveParams } = require('./params.cjs');
const { ownStrandedMass } = require('./cutoff.cjs');

// 斩首锁定（跨回合）：合力推皇冠是多 tick 连续攻击——第一击打残、第二击收割。
// 锁定期间 choose() 优先继续打同一皇冠，不被别的候选抢走 tick；目标被推掉、
// 合力不再足够或超时即解除。这是用户明确要求的「目标锁定」，不是复活旧版计划状态。
const strikeLocks = new WeakMap();

function createFrontline(state, params = {}) {
  const ctx = createContext(state, params);
  if (!ctx) return null;
  const p = resolveParams(params);
  const { n, m, size, owners, grid, army, me, count, own, hostile, friendly, allied, passable, known } = ctx;
  const diagnostics = { rejected: {}, examples: [], candidates: 0 };
  function reject(code, detail) {
    diagnostics.rejected[code] = (diagnostics.rejected[code] || 0) + 1;
    if (detail && diagnostics.examples.length < 5) diagnostics.examples.push({ code, ...detail });
    return null;
  }
  const allowed = (owner) => !params.allowedOwners || params.allowedOwners.has(owner);
  const blocked = (a, b) => params.blockedEdges?.has(`${a}:${b}`);

  function classify(a, b) {
    if (grid[b] === owners[b] + 100) return 'crown';
    if (grid[b] === owners[b] + 50) return 'city';
    if (owners[b]) return 'enemy';
    return 'neutral';
  }

  function evaluate(move) {
    if (!move) return null;
    if (move.kind === 'build') return { move, score: -Infinity };
    const { x, y, dx, dy } = move;
    if (![x, y, dx, dy].every(Number.isInteger) || x < 0 || x >= n || dx < 0 || dx >= n ||
        y < 0 || y >= m || dy < 0 || dy >= m || Math.abs(x - dx) + Math.abs(y - dy) !== 1) return null;
    const a = x * m + y, b = dx * m + dy;
    if (!own(a)) return reject('来源非可操作己方格', { from: a, to: b });
    if (blocked(a, b)) return reject('移动历史禁行边', { from: a, to: b });
    const targetOwner = owners[b];
    if (allied(targetOwner, me)) {
      // 己方内部运输：两端 2 跳内都没有敌人时整批运输，否则保留引擎的智能留兵。
      const quiet = ctx.pressure(a, { exclude: b }).total === 0 && ctx.pressure(b, { exclude: a }).total === 0 &&
        !ctx.unknownNear(a) && !ctx.unknownNear(b);
      return { move: quiet ? { ...move, mode: 2, half: false } : move, score: -Infinity };
    }
    if (!known[b]) return reject('目标不可见或不可通行', { from: a, to: b });
    if (targetOwner && !allowed(targetOwner)) return reject('FFA目标限制', { from: a, to: b, owner: targetOwner });

    const A = count(a);
    const D = count(b, 1);
    const cap = A - 1;
    if (cap <= 0) return reject('来源无兵', { from: a, A });
    // 引擎 mode 0 的邻格留兵（不含目标格），用于估算 mode 0/1 的实际出兵量。
    let sideReserve = 0;
    for (const v of ctx.neighbors[a]) {
      if (v === b || !passable(v) || allied(owners[v], me)) continue;
      sideReserve += Math.max(0, count(v) - 1);
    }
    const smart = Math.max(0, Math.min(cap, A - sideReserve - 1));
    const src = ctx.pressure(a, { exclude: b });
    const tgt = ctx.pressure(b, { exclude: a });
    const mates = ctx.friendlyAdjacent(b, a);
    const reinforce = ctx.reinforcement(b, a, p);
    const kind = classify(a, b);
    const isCrown = kind === 'crown';
    const isCity = kind === 'city';
    // 斩首方针（用户 2026-09-27 硬性规则）：推皇冠不评估对方防守强弱——
    // 不把旁边敌大堆的同 tick 增援算进守军，只看目标格当前守军（含下一 tick 增长）。
    const defense = isCrown ? D : D + reinforce;
    const unknownNear = ctx.unknownNear(a) || ctx.unknownNear(b);
    // 源点留守：贴着源点的敌人必须留够（下一 tick 就可能反打），两跳外的按折扣计。
    // 周围完全干净时保留 1 兵即可，全冲（mode 2）才有意义。
    const pressureKeep = Math.ceil(src.adj * p.sourceKeep + src.near * 0.3);
    // 3 跳内的敌军同样算数（不能只看贴脸的两跳），但最多只强制留守一半，
    // 保证「有威胁时仍能打出去」，同时不再让边境格被抽成 1 兵空壳。
    const wide = ctx.frontDistance[a] === 0 && p.wideKeepWeight > 0
      ? ctx.pressure(a, { radius: 3, decay: 0.5 }).total : 0;
    const wideKeep = Math.min(Math.ceil(A * 0.5), Math.ceil(wide * p.wideKeepWeight));
    const keepSource = Math.max(pressureKeep > 0 ? 2 : 1, pressureKeep, wideKeep);
    const localRatio = A / Math.max(1, defense + tgt.adj + src.adj);
    // 全局兵力落后时不再做亏本交换：只打真正赚的仗。
    const behindArmy = ctx.race.bestOwner !== null && ctx.race.myArmy < 0.95 * ctx.race.bestArmy;
    const exchangeNeed = p.exchangeRatio * (behindArmy ? 1.6 : 1);
    // ── 拆建筑最高优先 ────────────────────────────────────────────────
    // 拿下敌方的皇冠/指挥所会直接摧毁它：对方至少损失 100 兵的投资与每 tick +1 的产能，
    // 所以只要能攻下就照打，不要求「打赚」、不看全局兵力落后、不被 console 整合期挡住。
    // 唯一例外：不能拿我们自己的建筑去换（那等于互删，净亏产能）。
    const buildingTarget = isCrown || isCity;
    const ownBuilding = grid[a] === me + 100 || grid[a] === me + 50;
    // ── 斩首：攻冠兵力三级递升（用户 2026-09-28 方针「三」）────────────────
    // 从「半兵/全兵」二值跳变细化成渐进加码，减少全家梭哈：
    //   ① 半兵推得下就只出半兵（余兵留守，源点防御义务不动）；
    //   ② 半兵不够先试智能全兵（mode0 智能分兵口径：就近合力、不从过远格
    //      硬调、贴脸敌军的留守/防御义务照算）；
    //   ③ 智能全兵也不够才退真全兵（mode2 全压，只留 1 兵）。
    // 「推皇冠不评估对方防守强弱」的方针不变（不把旁边敌大堆算进守军）；
    // 反击、交换、整合期、全局兵力落后一律不参与斩首决策；自家建筑源点
    // 仍按 keepSource 留守（防守逻辑保留）。
    if (isCrown) {
      const pushOf = (mode) => mode === 1 ? Math.floor(smart / 2) : mode === 2 ? cap : smart;
      const tierName = (mode) => mode === 1 ? '半兵' : mode === 0 ? '智能全兵' : '真全兵';
      for (const mode of [1, 0, 2]) {
        const push = pushOf(mode);
        if (push <= 0) continue;
        if (ownBuilding && A - push < keepSource) continue;
        if (push - defense >= p.minArrive) {
          return { move: { ...move, mode, half: false,
            reason: `斩首：${tierName(mode)}推皇冠，出兵${push}，留守${A - push}` },
            score: 950, kind };
        }
      }
      // 多路合力：同样三级。智能口径按「智能分兵合力」加总——每个合力格只出
      // smart 份（扣除它自己贴脸敌军的留守义务，与源点 smart 同一口径），只数
      // 贴着皇冠的邻格（就近合力，不从过远格硬调）；自家建筑不当合力源（留守
      // 估计只对本源点算过，保守起见不抽空别的建筑）。智能合力压过守军
      // +crownSmartMargin 就用智能模式打第一击；不够再按真全兵口径（每格
      // count-1 全压）合计，压过守军 +crownFullMargin 才允许 mode2 全压。
      // 余量至少 +1：否则最后一击与剩余守军相等，收割格推不下 0 守军的皇冠
      // （引擎：兵力相等不占格），白送第一击。
      let smartCombined = 0, fullCombined = 0;
      for (const j of ctx.neighbors[b]) {
        if (!friendly(j) || grid[j] === me + 100 || grid[j] === me + 50) continue;
        const force = Math.max(0, count(j) - 1);
        fullCombined += force;
        let jReserve = 0;
        for (const v of ctx.neighbors[j]) {
          if (v === b || !passable(v) || allied(owners[v], me)) continue;
          jReserve += Math.max(0, count(v) - 1);
        }
        smartCombined += Math.max(0, Math.min(force, count(j) - jReserve - 1));
      }
      const smartEnough = smartCombined > defense + p.crownSmartMargin;
      const fullEnough = fullCombined > defense + p.crownFullMargin;
      if (smartEnough || fullEnough) {
        for (const mode of smartEnough ? [0, 1, 2] : [2, 0, 1]) {
          const push = pushOf(mode);
          if (push <= 0) continue;
          if (ownBuilding && A - push < keepSource) continue;
          const combined = smartEnough ? smartCombined : fullCombined;
          return { move: { ...move, mode, half: false,
            reason: `合力斩首（${tierName(smartEnough ? 0 : 2)}）：第一击出兵${push}（合力${Math.round(combined)}对守军${Math.round(defense)}），连续攻击直到推掉` },
            score: 900, kind, strike: { target: b } };
        }
      }
      // 合力也不够 → 落到通用路径（大堆对皇冠仍可能触发消耗冲击）。
    }
    // 源点留守规则照旧（否则一兵建筑下一 tick 就被顺手拆掉，净亏产能）。
    // ── 深入敌境判定（用户 2026-09-27 方针，细化第二轮「进攻一律全兵」）──────
    // 看源点与我方领土/前线的关系：源点的可通行邻格（不含目标）里敌占格明显多于
    // 我方格，说明我军只是经窄走廊/突出部插进敌方腹地——侧翼全是敌人，全兵压上
    // 等于把后方据点放空。源点背后是我方连片领土的贴界常规推进不算深入。
    let foeCells = 0, ownCells = 0;
    for (const j of ctx.neighbors[a]) {
      if (j === b || !passable(j)) continue;
      if (owners[j] > 0 && !allied(owners[j], me)) foeCells++;
      else if (known[j] && allied(owners[j], me)) ownCells++;
    }
    const deepPush = (kind === 'enemy' || kind === 'city') && foeCells >= 2 && foeCells > ownCells;
    // 对方完全无威胁：源点两跳内没有能反打的敌兵，且可见敌军总量还不及这一路源头——
    // 没有什么要守的，深入也直接全兵。
    const noThreat = src.total === 0 && ctx.race.enemyArmy < A;
    // 浓缩突击豁免（学自 _E_ 的单堆全冲）：决定性大堆（≥megaStackMin 且压过目标局部
    // 防守 assaultMargin 倍）深入敌境时仍维持全兵优先——每步只派一半会让大堆在抵达
    // 皇冠前自剥殆尽。全冲仍受 allInSafe 闸门（新占格兵力须压得住源点旁敌军）约束，
    // 全冲后走廊脖子的截断风险由 neck-guard 模块兜底；普通深入推进的半兵方针不变。
    const decisiveStack = A >= p.megaStackMin && A >= p.assaultMargin * (defense + tgt.adj);
    // ── maze 拓展纪律（用户 2026-09-27 硬方针）─────────────────────────────
    // 迷宫里拓展走廊一旦被截断可能永久失联：① 拓展（打中立格）只派必要兵力——
    // 模式排序换成 [半兵, 智能分兵]（能占下目标格的最小比例），大部队留在原地
    // 镇关卡；② 源点是「移除后会冻住 ≥cutoffMinIsolate 兵力」的关卡且贴脸有敌时
    // （敌方一 tick 就能切断走廊），不为拓展削弱关卡——先打/先守，不拓（攻击
    // 对方土块不受此限）；③ 中立拓展不做交换（占下也站不住的拓展不拓）。
    // 「优先攻击对方土块」由既有估值顺序保证（敌格 62 > 中立 26）。
    const mazeExpand = ctx.mazeLike && kind === 'neutral';
    if (mazeExpand && src.adj > 0) {
      const stranded = ownStrandedMass(ctx, a, p.cutoffScan);
      if (stranded !== null && stranded >= p.cutoffMinIsolate)
        return reject('maze拓展：源点关卡贴敌，先打先守不削弱咽喉', { from: a, to: b, stranded: Math.round(stranded) });
    }
    // ── 阶段化扩张-要塞方针（用户 2026-09-27 定稿，E 原局校准）───────────────
    // E 的净扩张速率在 turn 60–75 坍缩、皇冠从 75 起跳：前期抢地盘不动；中后期
    // 薄皮大摊子是自杀形态——中立扩张必须「有要塞撑腰」（源点在己方建筑
    // lateAnchorRadius 辐射圈内）或「自己够厚」（占领后驻军 ≥ lateSkinMin），
    // 否则这一 tick 不拓，兵留在源点养厚/转投要塞建设。敌方目标与拆建筑不算
    // 「扩张」，不受此限（中后期少量精要扩张，不是完全不扩）。
    const fortressBacked = ctx.anchorDistance[a] >= 0 && ctx.anchorDistance[a] <= p.lateAnchorRadius;
    const lateThinExpand = Number.isInteger(ctx.turn) && ctx.turn >= p.fortressPhaseTurn &&
      kind === 'neutral' && !fortressBacked;
    // 深入且有威胁时能半兵就半兵（像正常扩散铺路一样，半兵够拿下目标格就只派一半，
    // 留一半守原地）；半兵攻不进去时按顺序落到全兵——「半兵推不动还硬推」被 arrive
    // 闸门拦住。常规推进（非深入）维持第二轮「全兵优先」：按 [全冲, 半兵, 智能分兵]
    // 顺序取第一个通过留守/预算闸门的模式，「兵够却分多次小勺推同一目标」视为 bug。
    const deepHalf = deepPush && !noThreat && !decisiveStack;
    const modes = mazeExpand ? [1, 0] : deepHalf ? [1, 2, 0] : [2, 1, 0];
    const arriveFloor = lateThinExpand ? Math.max(p.minArrive, p.lateSkinMin) : p.minArrive;
    let best = null;
    for (const mode of modes) {
      const push = mode === 1 ? Math.floor(smart / 2) : mode === 2 ? cap : smart;
      if (push <= 0) continue;
      const arrive = push - defense;
      const left = A - push;
      // 占领格必须留下能站住的兵，禁止 1 兵蚕食式进攻（那是给对手送地）。
      // 中后期无要塞撑腰的中立扩张还要「自己够厚」（lateSkinMin），否则不拓。
      if (arrive < arriveFloor) continue;
      // 全冲（留 1 兵）的放行条件：目标是敌方领土、源点不是自家建筑，
      // 且新占格的兵力至少能压住源点旁边的敌军。这样「半兵打不穿、全冲又不许」
      // 的死锁就不会出现（实地日志里 A=223 对守军 115、A=223 对守军 35 都被卡死）。
      const allInSafe = !ownBuilding && kind !== 'neutral' &&
        arrive >= Math.min(keepSource, Math.max(2, src.adj * 1.2));
      const requiredKeep = ownBuilding ? keepSource : allInSafe ? 1 : keepSource;
      if (left < requiredKeep) continue;
      if (unknownNear && !buildingTarget && (left < p.unknownMargin || arrive < 4)) continue;
      // 占领后下一 tick 的相对优势：来援的己方邻格 + 新到兵力 − 目标周围可反击的敌军。
      const exposure = arrive + mates.force * 0.5 - tgt.adj * p.counterWeight;
      let accepted = exposure > 0;
      let exchange = false;
      // 正在被反推：只接高价值目标，先把地守住再谈扩张。
      // 但 exposure>0 的稳赢收割（例如 1800 兵打 105 守军的隔壁格）不该被「转守」拦下——
      // 实地回放里这条无条件否决把 17 倍兵力差的收割锁了 80 个 tick。
      if (params.consolidate === true && !buildingTarget && !accepted) continue;
      if (!accepted) {
        if (buildingTarget) accepted = true;                               // 拆建筑：损失可接受
        else if (!mazeExpand && !behindArmy && localRatio >= exchangeNeed && left > src.adj) { accepted = true; exchange = true; }
      }
      if (!accepted) continue;
      const value = isCrown ? 900 : isCity ? 500 : kind === 'enemy' ? 62 : p.paintValue;
      const kill = kind === 'neutral' ? 0 : Math.min(D, 90) * 1.1;
      const exposureScore = Math.max(-160, Math.min(160, exposure * 0.45));
      const rear = ctx.frontDistance[a];
      const supportBonus = Math.min(3, mates.tiles) * 14;
      // 深入敌境的宽块滚动：目标占领后连同源点有 ≥2 个己方邻格时，锋面加厚成块
      // 而不是露出新的单格突出（侧翼不露单格突出，与画圈推进同向）。
      const widenBonus = deepPush && mates.tiles >= 2 ? 20 : 0;
      const lingerPenalty = (rear >= 0 ? Math.max(0, 4 - rear) : 4) * 8;
      // ── 推进方向纪律（用户 2026-09-27 硬方针）：不要大范围涂色 ────────────
      // 方向权重向「敌方皇冠/核心方向」强倾斜：目标格比源点更靠近敌核心
      // （crownDistance 严格下降）加分，侧向/倒退减分；与进攻主线无关的侧翼
      // 中立涂色格再按距敌核心远近大幅降权——离我家远、离敌家也远的中间地带
      // 最不值钱，兵力向敌人家附近逼近、深入推进，而不是横向摊面积。
      const coreFrom = ctx.crownDistance[a], coreTo = ctx.crownDistance[b];
      const towardCore = coreFrom >= 0 && coreTo >= 0 ? Math.sign(coreFrom - coreTo) : 0;
      let directionScore = towardCore * p.pushDirectionWeight;
      if (kind === 'neutral' && towardCore <= 0 && coreTo >= 0)
        directionScore -= Math.ceil(p.flankPaintPenalty * Math.min(1, coreTo / Math.max(1, p.paintDiscardDist)));
      let score = value + kill + exposureScore + supportBonus + widenBonus - lingerPenalty + directionScore +
        Math.min(arrive, 250) * 0.3 + Math.min(left, 400) * 0.05 - (exchange ? 30 : 0);
      // ── 薄土不值钱（用户 2026-09-29 硬方针）──────────────────────────────
      // 1-2 兵守不住、一割就没的边缘涂色格期望收益为负：占领驻军越薄扣分越多，
      // 扣到负数后 choose() 会跳过该候选（操作槽位让给建造/集结/截断）。
      if (kind === 'neutral' && arrive < p.paintThinArrive)
        score -= Math.ceil((p.paintThinArrive - arrive) * p.paintThinPenalty);
      const reason = isCrown ? `攻冠：出兵${push}，留守${left}`
        : isCity ? `攻指挥所：出兵${push}，留守${left}`
          : exchange ? `边界交换：出兵${push}，留守${left}`
            : `边界推进：${mode === 1 ? (deepHalf ? '深入半兵' : '半兵') : mode === 2 ? '全冲' : '智能分兵'}，留守${left}，占领后${arrive}`;
      // modes 已按当前方针排序（深入有威胁 [半兵, 全冲, 智能分兵]，其余 [全冲, 半兵, 智能分兵]），
      // 第一个被闸门放行的就是答案。
      best = { move: { ...move, mode, half: false, reason }, score, kind };
      break;
    }
    if (!best) {
      // ── 消耗冲击：打破「两堆兵隔着一条线无限积累」的对峙死锁 ──────────────
      // 拿不下目标格也要打：用同等兵力换掉对方守军，把大堆打小，为后续突破留出兵力差。
      // 兵力接近、或我方全局产能占优时主动换；同一条边静默超过 stallTicks 时，
      // 即使我方不占优也要动手——长期对峙本身就是最差的结果（节奏死、产能白攒）。
      // 是否值得打消耗战，完全由当前局面推出（不看历史、不看计时器）：
      // 兵力储备或产能占优的一方，1:1 换兵就是赚的；优势越大越愿意用局部劣势换对方主力。
      if (kind !== 'neutral' && A >= p.grindMin && params.consolidate !== true) {
        const reserveEdge = ctx.race.myArmy / Math.max(1, ctx.race.bestArmy);
        const myProduction = ctx.race.myCrowns + ctx.race.myLand / 50;
        const foeProduction = ctx.race.bestCrowns + ctx.race.bestLand / 50;
        const productionEdge = myProduction / Math.max(0.1, foeProduction);
        // 兵力不落后就可以按「接近均势」换；产能碾压（对方几乎没有皇冠）时，
        // 哪怕局部兵力少一半也换——他们补不回来，我们补得回来。
        let need = p.grindAdvantage;
        const dominant = reserveEdge >= 1.4 || productionEdge >= 6;
        if (reserveEdge >= 1.0 || productionEdge >= 3) need *= 0.6;
        if (dominant) need = Math.min(need, p.stallRatio);
        if (A >= need * defense) {
          // 消耗战也要留够：自家建筑必须留下挡得住贴邻敌军的守军，普通格才允许只留 20%。
          const floor = Math.max(1, Math.min(keepSource, Math.ceil(A * p.grindKeep)),
            ownBuilding ? src.adj + 1 : 0);
          let choice = null;
          for (const mode of [1, 0, 2]) {
            const push = mode === 1 ? Math.floor(smart / 2) : mode === 2 ? cap : smart;
            if (push < p.grindMin || A - push < floor) continue;
            if (!choice || push > choice.push) choice = { mode, push };
          }
          if (choice) {
            const killed = Math.round(Math.min(choice.push, defense));
            const grindScore = 5 + Math.min(killed, 600) * 0.05 + (isCrown ? 300 : isCity ? 80 : 0);
            return { move: { ...move, mode: choice.mode, half: false,
              reason: `消耗冲击${dominant ? '（优势换兵）' : ''}：出兵${choice.push}，换掉约${killed}敌兵` }, score: grindScore };
          }
        }
      }
      return reject('出兵或留守预算未通过', { from: a, to: b, A, D, defense: Math.round(defense),
        sourceAdj: Math.round(src.adj), targetAdj: Math.round(tgt.adj), keepSource, unknownNear });
    }
    return best;
  }

  return {
    diagnostics,
    context: ctx,
    assess: (move) => evaluate(move)?.move ?? null,
    choose() {
      // ── 斩首锁定：合力推皇冠的连续攻击优先于一切新候选 ──────────────
      // 目标仍是敌皇冠、相邻合力仍压过守军时，从最强邻格继续打（推不掉就打残，
      // 下回合守军 = 守军 − 本击出兵，直到推掉）；否则解除锁定。
      const lock = strikeLocks.get(state);
      if (lock && Number.isInteger(ctx.turn)) {
        if (ctx.turn < lock.since || ctx.turn > lock.until) strikeLocks.delete(state);
        else {
          const b = lock.target;
          const foe = owners[b] && !allied(owners[b], me) && allowed(owners[b]);
          if (!(known[b] && foe && grid[b] === owners[b] + 100)) strikeLocks.delete(state);
          else {
            const D = count(b, 1);
            let combined = 0, cell = -1, cellForce = 0;
            for (const j of ctx.neighbors[b]) {
              if (!friendly(j) || grid[j] === me + 100 || grid[j] === me + 50) continue;
              const force = Math.max(0, count(j) - 1);
              combined += force;
              if (force > cellForce && !blocked(j, b)) { cellForce = force; cell = j; }
            }
            if (cell >= 0 && combined > D + 1) {
              const next = evaluate({ x: Math.floor(cell / m), y: cell % m,
                dx: Math.floor(b / m), dy: b % m, mode: 2 });
              if (next) return next.move;
            } else strikeLocks.delete(state);
          }
        }
      }
      const candidates = [];
      for (let a = 0; a < size; a++) {
        if (owners[a] !== me || !own(a) || count(a) <= 2) continue;
        for (const b of ctx.neighbors[a]) {
          if (!passable(b) || allied(owners[b], me) || !known[b]) continue;
          if (owners[b] && !allowed(owners[b])) continue;
          if (blocked(a, b)) continue;
          const crown = grid[b] === owners[b] + 100 ? 1 : 0;
          const city = grid[b] === owners[b] + 50 ? 1 : 0;
          candidates.push({ a, b, crown, city, edge: count(a) - count(b) });
        }
      }
      candidates.sort((a, b) => b.crown - a.crown || b.city - a.city || b.edge - a.edge || a.a - b.a);
      diagnostics.candidates = candidates.length;
      diagnostics.isolatedSources = 0;
      for (let i = 0; i < size; i++) if (owners[i] === me && ctx.isolated(i) && army[i] > 1) diagnostics.isolatedSources++;
      let best = null;
      for (const { a, b } of candidates.slice(0, 128)) {
        const value = evaluate({ x: Math.floor(a / m), y: a % m, dx: Math.floor(b / m), dy: b % m, mode: 1 });
        // 薄土涂色期望收益为负时不执行（用户 2026-09-29 硬方针「薄土不值钱」）——
        // 操作槽位让给建造/筹资/集结/截断，而不是把 1-2 兵撒到守不住的边缘格上。
        if (value && value.kind === 'neutral' && value.score < 0) continue;
        if (value && (!best || value.score > best.score)) best = value;
      }
      // 合力第一击落地 → 登记斩首锁定，下回合起 choose 优先连续攻击同一皇冠。
      if (best?.strike && Number.isInteger(ctx.turn))
        strikeLocks.set(state, { target: best.strike.target, since: ctx.turn, until: ctx.turn + 12 });
      return best?.move ?? null;
    },
  };
}
module.exports = { createFrontline };
