/**
 * economy.js — 经济建设：快建、多建皇冠的「铺皇冠」策略。
 *
 * 规则依据（src/game-engine/tick-growth.ts 与 game-engine.ts 的
 * chkBuildCity / chkUpgradeCrown）：
 *   主城（皇冠）每 tick +1 兵；指挥所与普通格一样每 50 tick 才 +1
 *   （指挥所不增产！）；爆发期（26–50 tick）普通格每 tick 额外 +1。
 *   建造/升级各耗 50 兵；皇冠只能「建指挥所 → 升级」两步走来。
 *   一座皇冠 = 每 tick +1，是普通格/指挥所的 50 倍产能——获胜者的共同
 *   特征就是大量皇冠集群。因此本模块的核心是「直接新建皇冠」：攒到
 *   101 兵才建指挥所（建城剩 51，下回合兵力即过升级线 51 直接升冠，
 *   b/c 连续两回合完成），指挥所只是通往皇冠的一步中间态，绝不让它
 *   长期趴着占兵，也不反复挪兵拖沓。
 *
 * 唯一的限制是安全与节奏：
 *   - 选址：皇冠簇优先——贴着现有锚点（皇冠/指挥所）的格子大幅加分，
 *     快速连成集群（远离锚点的飞地一被截断就整片失效，反而扣分）；
 *     frontierDist 2–4 的「二线甜区」其次；贴前线（fd ≤ 1）不建
 *     （进攻不靠指挥所铺路），仅死区（周边 5 格无活敌）视同二线。
 *   - 升级优先于新建：指挥所兵力一够就升皇冠（不设冷却、评分显著高于
 *     新建）。
 *   - 节奏：新建指挥所有 BUILD_GAP_TICKS 冷却（一次 50 兵不能连续放），
 *     升级皇冠不设冷却（各格自负盈亏）；威胁逼近（hops ≤ 4）时建设
 *     冻结，除非该格兵力富余到建完还很厚实。
 *   - 喂养：对「差十几兵就能建」的内陆普通格、贴锚点的簇内格（2 兵
 *     起喂）、以及兵力回血不足升级线的内陆指挥所输出 feedTarget，
 *     无集结任务时 logistics 的输送流会顺路把它们喂过门槛——指挥所
 *     与普通格自身每 50 tick 才 +1，靠汇集供粮才能让「建城 → 升皇冠」
 *     的链条持续滚动。
 *   - 争夺记忆：最近 10 tick 内发生过归属翻转的格子默认不建（拉锯格
 *     上重建只会反复白扔 50 兵），除非兵力特别厚实或开局 bootstrap。
 */

const BUILD_COST = 50;
// 新建指挥所冷却（tick）：升级皇冠不占用此冷却。
const BUILD_GAP_TICKS = 3;
// 升级皇冠门槛 51：与 101 建设门槛咬合——101 建城后剩 51，下回合直接
// 升冠（引擎校验 ≥50），b/c 连续两回合完成「直建皇冠」，不反复挪兵。
const UPGRADE_CROWN_MIN_ARMY = 51;
// 新建指挥所常规门槛 101 = 50（建城）+ 51（下回合升冠）：指挥所不增产
// （与普通格同速），唯一价值是升级皇冠的中间态与连通锚点，因此必须攒到
// 「建完下回合即可升冠」才动手——对外表现为「直接新建皇冠」，而不是让
// 指挥所长期趴着占兵。开局补第二锚点（连通保险）放宽到 52。
const BUILD_CITY_MIN_ARMY = 101;
const BOOTSTRAP_MIN_ARMY = 52;
// 威胁逼近（hops ≤ 此值）时冻结建设；兵力达到此线的富余格不受冻结影响。
const DEFENSE_FREEZE_HOPS = 4;
const RICH_OVERRIDE_ARMY = 130;
// 喂养输送只覆盖「差这么多兵以内就能建」的内陆格。
const FEED_BAND = 15;
// 贴锚点的簇内格从 2 兵起就喂：皇冠邻格是集群的种子，皇冠每 tick +1
// 持续喂过去，喂过建设门槛即建城、回血即升冠。
const CLUSTER_FEED_MIN_ARMY = 2;

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
      // 升级优先于新建：评分显著高于 build-city，有条件就先升皇冠。
      score: 420 + Math.min(army, 120) / 4 + (fd >= 3 ? 15 : 0),
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
    // 开局只有初始主城时最优先补第二锚点（经济 + 连通保险：被截断的
    // 领土会减半并孤军化；注意出局只看皇冠数，指挥所不保命）。
    const bootstrap = crowns <= 1 && cities === 0;
    let bestFeed = null;

    for (const idx of ctx.myCells()) {
      if (ctx.isolatedAt(idx) || ctx.tileKind(idx) !== 'plain') {
        continue;
      }
      const army = ctx.army(idx);
      let fd = frontierDist[idx];
      if (fd <= 1) {
        // 贴前线格默认不建（进攻不需要指挥所铺路）；仅死区（周边 5 格
        // 无活敌）视同二线。
        if (inDeadZone(enemyDistAll, idx)) {
          fd = 2;
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

      const threshold = bootstrap ? BOOTSTRAP_MIN_ARMY : BUILD_CITY_MIN_ARMY;
      if (defenseFreeze && army < RICH_OVERRIDE_ARMY) {
        continue;
      }
      const ad = anchorDistMine[idx];
      if (army < threshold) {
        // 喂养候选：内陆安全格差十几兵就能建、或贴锚点的簇内格（门槛更
        // 低，集群优先喂起来），交给输送流顺路喂过门槛。
        const inBand = fd >= 3 && army >= threshold - FEED_BAND;
        const clusterFeed = ad === 1 && fd >= 2 && army >= CLUSTER_FEED_MIN_ARMY;
        if (!defenseFreeze && !feedTarget && (inBand || clusterFeed) && (!bestFeed || army > bestFeed.army)) {
          bestFeed = { idx, army };
        }
        continue;
      }

      // 皇冠簇优先：贴着现有锚点建（快速连成集群）；远离锚点的飞地脆弱、
      // 一被截断整片失效，扣分不鼓励。
      let score = 230 + Math.min(army, 150) / 5;
      if (ad === 1) {
        score += 55;
      } else if (ad === 2) {
        score += 25;
      } else if (ad < 0 || ad >= 4) {
        score -= 40;
      }
      if (ctx.myChokes().has(idx)) {
        // 咽喉格上建指挥所 = 给可能被截断的区域永久上锚，防御价值极高。
        score += 45;
      }
      if (fd >= 2 && fd <= 4) {
        score += 20; // 二线甜区
      } else if (fd <= 6) {
        score += 10;
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
