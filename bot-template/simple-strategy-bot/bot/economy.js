/**
 * economy.js — 经济建设：快建、多建皇冠的「铺皇冠」策略。
 *
 * 规则依据（src/game-engine/tick-growth.ts）：
 *   主城（皇冠）每 tick +1 兵；指挥所与普通格每 50 tick 才 +1；爆发期
 *   （26–50 tick）普通格每 tick 额外 +1。建造/升级各耗 50 兵。
 *   一座皇冠 = 每 tick +1，是指挥所/普通格的 50 倍产能——获胜者的共同
 *   特征就是大量皇冠集群。因此本模块不设数量上限：凡是安全的格子兵力
 *   越过门槛就建指挥所、指挥所兵力一回血就升皇冠，让产能复利滚动。
 *
 * 唯一的限制是安全与节奏：
 *   - 选址：frontierDist 2–4 的「二线甜区」优先；贴前线（fd ≤ 1）默认
 *     不建，除非周边 5 格内没有活敌（死区），或进入铺皇冠阶段后该格
 *     兵力足够厚实（建完还有 50 兵镇守）；远离现有锚点的格子加分
 *     （前置锚点兼作连通保险与兵力中转）。
 *   - 节奏：新建指挥所有 BUILD_GAP_TICKS 冷却（一次 50 兵不能连续放），
 *     升级皇冠不设冷却（各格自负盈亏）；威胁逼近（hops ≤ 4）时建设
 *     冻结，除非该格兵力富余到建完还很厚实。
 *   - 喂养：对「差十几兵就能建」的内陆普通格、以及兵力回血不足升级线
 *     的内陆指挥所输出 feedTarget，无集结任务时 logistics 的输送流会
 *     顺路把它们喂过门槛——指挥所自身每 50 tick 才 +1，靠汇集供粮才能
 *     让「建城 → 升皇冠」的链条持续滚动。
 *   - 争夺记忆：最近 10 tick 内发生过归属翻转的格子默认不建（拉锯格
 *     上重建只会反复白扔 50 兵），除非兵力特别厚实或开局 bootstrap。
 */

const BUILD_COST = 50;
// 新建指挥所冷却（tick）：升级皇冠不占用此冷却。
const BUILD_GAP_TICKS = 3;
// 升级皇冠门槛：52 = 建完留 2 兵，皇冠下 tick 起每 tick +1 自我回血。
const UPGRADE_CROWN_MIN_ARMY = 52;
// 新建指挥所常规门槛（留 3 兵余量）；开局补第二锚点再放宽 1 点。
const BUILD_CITY_MIN_ARMY = 53;
const BOOTSTRAP_MIN_ARMY = 52;
// 威胁逼近（hops ≤ 此值）时冻结建设；兵力达到此线的富余格不受冻结影响。
const DEFENSE_FREEZE_HOPS = 4;
const RICH_OVERRIDE_ARMY = 130;
// 铺皇冠阶段：turn ≥ 此值后，贴前线格兵力够厚也允许建（终点是铺满全图）。
const CARPET_TURN = 120;
const CARPET_FRONTLINE_MIN_ARMY = 100;
// 喂养输送只覆盖「差这么多兵以内就能建」的内陆格。
const FEED_BAND = 15;

function buildOp(ctx, idx, op) {
  const { x, y } = ctx.xy(idx);
  return { kind: 'build', payload: { x, y, op } };
}

/** 贴前线格子的死区判定：周边 5 格 BFS 范围内没有活敌。 */
function inDeadZone(enemyDistAll, idx) {
  const ed = enemyDistAll[idx];
  return ed < 0 || ed > 5;
}

/**
 * @param threats 当前威胁列表（用于判定是否冻结建设）
 * @returns {{candidates: Array, feedTarget: {idx: number, baseScore: number} | null}}
 */
function planEconomy(ctx, state, threats) {
  const candidates = [];
  const frontierDist = ctx.frontierDist();
  const anchorDistMine = ctx.anchorDistMine();
  const enemyDistAll = ctx.enemyDistAll();
  const defenseFreeze = threats.length > 0 && threats[0].hops <= DEFENSE_FREEZE_HOPS;

  /* ---------- 升级主城（指挥所 → 皇冠）：不设冷却，兵力够就升 ---------- */
  for (const idx of ctx.myCities()) {
    if (ctx.isolatedAt(idx)) {
      continue;
    }
    const army = ctx.army(idx);
    const fd = frontierDist[idx];
    let threshold = UPGRADE_CROWN_MIN_ARMY;
    if (fd <= 1) {
      threshold = 90; // 贴前线的指挥所：兵力厚一点再升，升了要守得住
    }
    if (defenseFreeze && army < 90) {
      continue;
    }
    if (army < threshold) {
      continue;
    }
    candidates.push({
      score: 360 + Math.min(army, 120) / 4 + (fd >= 3 ? 15 : 0),
      preempt: false,
      op: buildOp(ctx, idx, 'c'),
      srcKey: idx,
      tag: 'upgrade-crown',
    });
  }

  /* ---------- 新建指挥所：有冷却、无数量上限 ---------- */
  const cooledDown = state.turn - state.lastCityTurn >= BUILD_GAP_TICKS;
  let feedTarget = null;

  // 喂养目标（不占建设冷却）：兵力回血不足升级线的指挥所优先——
  // 指挥所每 50 tick 才 +1，靠输送汇集供粮才能尽快升皇冠。
  // 只喂不贴活敌的（keepAt = 1）：贴着敌军的指挥所喂进去也是送。
  if (!defenseFreeze) {
    let bestCityFeed = null;
    for (const idx of ctx.myCities()) {
      if (ctx.isolatedAt(idx) || ctx.keepAt(idx) > 1) {
        continue;
      }
      const army = ctx.army(idx);
      if (army < UPGRADE_CROWN_MIN_ARMY && (!bestCityFeed || army > bestCityFeed.army)) {
        bestCityFeed = { idx, army };
      }
    }
    if (bestCityFeed) {
      feedTarget = { idx: bestCityFeed.idx, baseScore: 100 };
    }
  }

  if (cooledDown) {
    const crowns = ctx.myCrowns().length;
    const cities = ctx.myCities().length;
    // 开局只有初始主城时最优先补第二锚点（经济 + 生存保险：最后一座
    // 主城被端即出局）。
    const bootstrap = crowns <= 1 && cities === 0;
    const carpet = state.turn >= CARPET_TURN;
    let bestFeed = null;

    for (const idx of ctx.myCells()) {
      if (ctx.isolatedAt(idx) || ctx.tileKind(idx) !== 'plain') {
        continue;
      }
      const army = ctx.army(idx);
      let fd = frontierDist[idx];
      let carpetFrontline = false;
      if (fd <= 1) {
        if (inDeadZone(enemyDistAll, idx)) {
          fd = 2; // 死区视同二线
        } else if (carpet && army >= CARPET_FRONTLINE_MIN_ARMY) {
          carpetFrontline = true; // 铺皇冠阶段：厚兵贴线格也建
        } else {
          continue;
        }
      }

      // 拉锯格（最近 10 tick 内有归属翻转）默认不建，防止反复重建白扔兵。
      const contestedAt = state.contested.get(idx);
      const contested = typeof contestedAt === 'number' && state.turn - contestedAt <= 10;
      if (contested && !bootstrap && army < RICH_OVERRIDE_ARMY) {
        continue;
      }

      let threshold = bootstrap ? BOOTSTRAP_MIN_ARMY : BUILD_CITY_MIN_ARMY;
      if (defenseFreeze && army < RICH_OVERRIDE_ARMY) {
        continue;
      }
      if (army < threshold) {
        // 喂养候选：内陆安全格差十几兵就能建，交给输送流顺路喂过门槛。
        if (
          !defenseFreeze &&
          !feedTarget &&
          !carpetFrontline &&
          fd >= 3 &&
          army >= threshold - FEED_BAND &&
          (!bestFeed || army > bestFeed.army)
        ) {
          bestFeed = { idx, army };
        }
        continue;
      }

      const ad = anchorDistMine[idx];
      let score = 250 + Math.min(army, 150) / 5;
      if (ad < 0 || ad >= 5) {
        score += 35; // 前置锚点：覆盖远离现有锚点的领土
      } else if (ad <= 2) {
        score -= 15; // 与现有锚点扎堆，覆盖价值略低
      }
      if (fd >= 2 && fd <= 4) {
        score += 20; // 二线甜区
      } else if (fd <= 6) {
        score += 10;
      }
      if (carpetFrontline) {
        score -= 30;
      }
      if (bootstrap) {
        score += 120;
      }
      candidates.push({
        score,
        preempt: false,
        op: buildOp(ctx, idx, 'b'),
        srcKey: idx,
        tag: 'build-city',
      });
    }

    if (!feedTarget && bestFeed) {
      // 略优于无焦点的前线输送（50），不抢占扩张与集结。
      feedTarget = { idx: bestFeed.idx, baseScore: 80 };
    }
  }

  return { candidates, feedTarget };
}

module.exports = { planEconomy, BUILD_GAP_TICKS };
