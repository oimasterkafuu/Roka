'use strict';
// 优势垃圾话（bot 聊天的人格层）：只在优势时开口，文案风格参考帝国时代 2
// 嘲讽语音文字——礼貌又欠揍，质朴毒舌但不下流。
//
// - 文案库分四档：small 小优 / big 大优 / crush 碾压 / struggle 对手挣扎；
//   每档内部轮换、本局已用句子不再复读。
// - 触发看综合局势，不只看兵力：领土比突破阈值 / 兵力差翻倍 / 全面碾压 /
//   连续吃掉对方建筑（窗口期）/ 累计踩掉 N 座皇冠指挥所 / 对方长时间无进展，
//   每种触发有独立冷却。文案引用真实状态（兵力比 / 领土比 / 踩冠数）。
// - wololo 彩蛋：写死一条「wololo」，仅在对方因被截断/隔离而瞬间丧失大量
//   土地的那一 tick 触发；不进常规轮换池、不占常规额度，但每局限 1 次。
// - 频率克制：全局冷却 + 每局次数上限 + 概率门控，不是每局都说；
//   只在优势时说，劣势闭嘴（绝境走 bot/surrender.cjs 的投降判定）。
// 局面数据来自 bot/threat.cjs 的共享分析层（createContext），与决策同源。
const { createContext } = require('./threat.cjs');
const { resolveParams } = require('./params.cjs');

const WOLOLO = 'wololo';

// 占位符：{armyRatio} {landRatio} 为对最强敌人的倍数（一位小数），
// {myArmy} {enemyArmy} {myLand} {enemyLand} {turn} {stall} {eaten} 为真实整数。
const LINES = Object.freeze({
  small: Object.freeze([
    '你好，需要我放慢一点吗？',
    '请多指教——目前兵力比 {armyRatio}:1。',
    '你的开局很有想法，继续保持。',
    '不好意思，这块地我先要了。',
    '第 {turn} 回合，友情提示：领土比 {landRatio}:1。',
    '别客气，慢慢来，我不急。',
    '你的防线修得很别致，真的。',
    '要喝水吗？我看你打得挺辛苦的。',
    '加油，你只差一点点了（{landRatio} 倍）。',
  ]),
  big: Object.freeze([
    '需要资源吗？我可以分你一点，反正用不完。',
    '我 {myArmy} 兵，你 {enemyArmy} 兵，咱们讲道理好不好？',
    '你已经很努力了，给你颁个参与奖。',
    '请问你的主力部队是迷路了吗？',
    '累计拆了你 {eaten} 座建筑了，谢谢惠顾。',
    '要不我们议和吧，你认输就行。',
    '兵力比 {armyRatio}:1，建议保存体力。',
    '你的主城风景不错，我待会儿过去看看。',
    '这局你打得很好，下一局继续努力。',
  ]),
  crush: Object.freeze([
    '你好，我是来收房租的，这片的房租。',
    '地图打开全是我的颜色，你的颜料是不是干了？',
    '{armyRatio} 倍兵力，我站着不动你都推不过来。',
    '请问还有王法吗？哦，我就是王法。',
    '你的军队 {enemyArmy} 兵，够我热身的。',
    '要不你猜一下我的主力在哪？猜错也没奖。',
    '我已经赢了，现在走的是流程。',
    '感恩相遇，第 {turn} 回合，好聚好散。',
    '别挣扎了，给彼此留点体面。',
  ]),
  struggle: Object.freeze([
    '需要帮忙吗？看你 {stall} 回合没挪窝了。',
    '你还好吗？你的地盘 {stall} 回合没动静了。',
    '刚刚那座建筑是自愿拆除的吗？',
    '累计 {eaten} 座建筑了，拆到手软，谢谢配合。',
    '别灰心，失败是成功之母，你有很多母亲。',
    '你的领土在缩水，需要我帮你叫救护车吗？',
    '战线在后退哦，需要地图导航吗？',
    '挣扎的样子很可爱，继续保持。',
    '我拆你建筑的速度比你建得快，要不换个爱好？',
  ]),
});

// 阵营统计：我方含同盟（组队局的 bot 队友），敌方取最强一族。
function sideStats(ctx) {
  let myArmy = 0, myLand = 0, myCrowns = 0, myCities = 0, enemyBuildings = 0;
  for (const entry of ctx.factions.values()) {
    if (ctx.allied(entry.owner, ctx.me)) {
      myArmy += entry.army; myLand += entry.land;
      myCrowns += entry.crowns; myCities += entry.cities;
    } else {
      enemyBuildings += entry.crowns + entry.cities;
    }
  }
  return { myArmy, myLand, myCrowns, myCities, enemyBuildings };
}

function createTrashTalk(params = {}, rng = Math.random) {
  const p = resolveParams(params);
  let spoken = 0, lastSpeakTurn = -Infinity;
  const lastTriggerTurn = new Map();
  const usedLines = new Map(); // tier → Set<已用索引>
  const eatenEvents = []; // [{ turn, count }] 窗口期吃掉的敌建筑
  let eatenTotal = 0; // 本局累计踩掉的敌皇冠/指挥所
  let prevEnemyBuildings = -1, prevEnemyLand = -1;
  let maxEnemyLand = 0, stallStart = -1, myLandAtStallStart = 0;
  let wololoUsed = false;

  function pickLine(tier, fill) {
    const pool = LINES[tier];
    const used = usedLines.get(tier) || new Set();
    if (used.size >= pool.length) return null; // 本局该档已说完，宁缺毋滥
    let index = Math.floor(rng() * pool.length);
    while (used.has(index)) index = (index + 1) % pool.length;
    used.add(index);
    usedLines.set(tier, used);
    return pool[index].replace(/\{(\w+)\}/g, (_, key) => String(fill[key] ?? ''));
  }

  function maybeSpeak(board) {
    if (!p.trashTalk || !board || board.ended || board.dead) return null;
    const turn = Number.isFinite(board.turn) ? board.turn : 0;
    const ctx = createContext(board, params);
    if (!ctx) return null;
    const race = ctx.race;
    if (!race.bestOwner) return null;
    const side = sideStats(ctx);
    const bestArmy = Math.max(1, race.bestArmy), bestLand = Math.max(1, race.bestLand);

    // 触发器状态追踪（每次调用都更新，不受发言门控影响）。
    if (prevEnemyBuildings >= 0 && side.enemyBuildings < prevEnemyBuildings) {
      const count = prevEnemyBuildings - side.enemyBuildings;
      eatenEvents.push({ turn, count });
      eatenTotal += count;
    }
    prevEnemyBuildings = side.enemyBuildings;
    while (eatenEvents.length && turn - eatenEvents[0].turn > p.trashStreakWindow) eatenEvents.shift();
    const buildingsEaten = eatenEvents.reduce((sum, e) => sum + e.count, 0);

    // wololo 彩蛋：敌方领土单 tick 暴跌（被截断/隔离结算）才触发，
    // 不进轮换池、不占额度、不受概率门控，但每局只此一次。
    const landCrash = prevEnemyLand >= 0 ? prevEnemyLand - race.enemyLand : 0;
    prevEnemyLand = race.enemyLand;
    if (!wololoUsed && landCrash >= p.trashWololoLandDrop) {
      wololoUsed = true;
      return WOLOLO;
    }

    if (race.bestLand > maxEnemyLand) {
      maxEnemyLand = race.bestLand;
      stallStart = turn;
      myLandAtStallStart = side.myLand;
    }
    const stallTicks = stallStart >= 0 ? turn - stallStart : 0;

    // 发言门控：回合下限 / 每局上限 / 全局冷却 / 只在优势（兵力与领土都不落后）。
    if (turn < p.trashTalkMinTurn) return null;
    if (spoken >= p.trashTalkMaxPerGame) return null;
    if (turn - lastSpeakTurn < p.trashTalkGlobalCd) return null;
    if (side.myArmy < race.bestArmy || side.myLand < race.bestLand) return null;

    const stats = {
      armyRatio: (side.myArmy / bestArmy).toFixed(1),
      landRatio: (side.myLand / bestLand).toFixed(1),
      myArmy: Math.round(side.myArmy), enemyArmy: Math.round(race.bestArmy),
      myLand: side.myLand, enemyLand: race.bestLand,
      turn, stall: stallTicks, eaten: eatenTotal,
    };
    // 触发器清单（综合局势，不止兵力）：各自独立冷却，按强度从高到低检查。
    const triggers = [
      { name: 'crush', tier: 'crush', cd: p.trashCdCrush,
        hit: side.myArmy >= p.trashCrushArmyRatio * bestArmy && side.myLand >= p.trashCrushLandRatio * bestLand },
      { name: 'eaten', tier: 'big', cd: p.trashCdEaten,
        hit: eatenTotal >= p.trashEatenTotal },
      { name: 'streak', tier: 'struggle', cd: p.trashCdStreak,
        hit: buildingsEaten >= p.trashStreakBuildings },
      { name: 'army', tier: 'big', cd: p.trashCdArmy,
        hit: side.myArmy >= p.trashArmyRatio * bestArmy },
      { name: 'stall', tier: 'struggle', cd: p.trashCdStall,
        hit: stallTicks >= p.trashStallTicks && side.myLand >= myLandAtStallStart + 5 },
      { name: 'land', tier: 'small', cd: p.trashCdLand,
        hit: side.myLand >= p.trashLandRatio * bestLand },
    ];
    for (const trigger of triggers) {
      if (!trigger.hit) continue;
      if (turn - (lastTriggerTurn.get(trigger.name) ?? -Infinity) < trigger.cd) continue;
      if (rng() >= p.trashTalkChance) continue; // 概率门控：不是每次触发都说
      const line = pickLine(trigger.tier, stats);
      if (!line) continue;
      spoken += 1;
      lastSpeakTurn = turn;
      lastTriggerTurn.set(trigger.name, turn);
      return line;
    }
    return null;
  }

  return { maybeSpeak, spokenCount: () => spoken };
}

module.exports = { createTrashTalk, LINES, WOLOLO };
