'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrashTalk, LINES, WOLOLO } = require('../bot/trash-talk.cjs');

// 10x10 棋盘：我方（玩家 1）从 0 号格开始摆，敌方（玩家 2）从 50 号格开始摆。
// 格子编码：1/2=普通格，51/52=指挥所，101/102=皇冠。
function board({ turn = 60, me = [], foe = [] }) {
  const s = { n: 10, m: 10, turn, playerId: 1, grid: Array(100).fill(0), army: Array(100).fill(0),
    isolated: Array(100).fill(0), teams: new Map([[1, 1], [2, 2]]) };
  let i = 0;
  for (const [g, a] of me) { s.grid[i] = g; s.army[i] = a; i += 1; }
  i = 50;
  for (const [g, a] of foe) { s.grid[i] = g; s.army[i] = a; i += 1; }
  return s;
}
const tiles = (count, g, a) => Array.from({ length: count }, () => [g, a]);
const pass = () => 0; // 概率门控必过、文案固定取各档首条未用句

function filledFrom(tier, line) {
  return LINES[tier].some((tpl) => {
    const re = new RegExp('^' + tpl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\w+)\\\}/g, '[^，。！？]*') + '$');
    return re.test(line);
  });
}

test('文案库不少于 30 条，四档齐全且全局无重复', () => {
  const all = Object.values(LINES).flat();
  assert.ok(all.length >= 30, `实际 ${all.length} 条`);
  for (const tier of ['small', 'big', 'crush', 'struggle']) assert.ok(LINES[tier].length >= 8, `${tier} 档不足`);
  assert.equal(new Set(all).size, all.length, '文案存在重复');
  assert.ok(!all.includes(WOLOLO), 'wololo 不进常规轮换池');
});

test('领土比突破阈值触发小优档，文案引用真实比值', () => {
  // rng 序列：概率门控 0 通过，取档内第 2 条（含 {armyRatio} 占位符）
  const seq = [0, 0.12]; let i = 0;
  const talk = createTrashTalk({}, () => seq[i++] ?? 0);
  const s = board({ me: tiles(20, 1, 4), foe: tiles(10, 2, 5) }); // 兵 80:50、地 20:10
  const line = talk.maybeSpeak(s);
  assert.equal(line, '请多指教——目前兵力比 1.6:1。');
});

test('兵力差翻倍触发大优档', () => {
  const talk = createTrashTalk({}, pass);
  const s = board({ me: tiles(10, 1, 40), foe: [...tiles(9, 2, 10), [102, 11]] }); // 兵 400:102、地 10:10
  const line = talk.maybeSpeak(s);
  assert.ok(line && filledFrom('big', line), `档位不符: ${line}`);
});

test('兵力领土全面碾压触发碾压档', () => {
  const talk = createTrashTalk({}, pass);
  const s = board({ me: tiles(40, 1, 20), foe: tiles(10, 2, 10) }); // 兵 800:100、地 40:10
  const line = talk.maybeSpeak(s);
  assert.ok(line && filledFrom('crush', line), `档位不符: ${line}`);
});

test('连续吃掉对方建筑（窗口期）触发对手挣扎档', () => {
  const talk = createTrashTalk({ trashEatenTotal: 30 }, pass); // 抬高累计门槛，隔离窗口触发
  const before = board({ turn: 60, me: tiles(12, 1, 20), foe: [[102, 100], ...tiles(3, 52, 10), ...tiles(6, 2, 10)] });
  assert.equal(talk.maybeSpeak(before), null);
  const after = board({ turn: 61, me: tiles(12, 1, 20), foe: [[102, 100], ...tiles(6, 2, 10)] }); // 3 座指挥所被吃
  const line = talk.maybeSpeak(after);
  assert.ok(line && filledFrom('struggle', line), `档位不符: ${line}`);
});

test('累计踩掉 N 座皇冠/指挥所触发大优档', () => {
  const talk = createTrashTalk({ trashEatenTotal: 5 }, pass);
  const before = board({ turn: 60, me: tiles(12, 1, 20), foe: [[102, 100], ...tiles(5, 52, 10), ...tiles(4, 2, 10)] });
  assert.equal(talk.maybeSpeak(before), null);
  const after = board({ turn: 61, me: tiles(12, 1, 20), foe: [[102, 100], ...tiles(4, 2, 10)] }); // 累计 5 座被吃
  const line = talk.maybeSpeak(after);
  assert.ok(line && filledFrom('big', line), `档位不符: ${line}`);
});

test('对方长时间无进展触发对手挣扎档', () => {
  const talk = createTrashTalk({ trashStallTicks: 40 }, pass);
  const foe = [...tiles(10, 2, 10), [102, 50]];
  assert.equal(talk.maybeSpeak(board({ turn: 60, me: tiles(12, 1, 10), foe })), null);
  // 41 tick 过去：敌地盘静止，我方地盘净增 5 格
  const line = talk.maybeSpeak(board({ turn: 101, me: tiles(17, 1, 10), foe }));
  assert.ok(line && filledFrom('struggle', line), `档位不符: ${line}`);
});

test('wololo 彩蛋：敌方领土单 tick 暴跌（隔离结算）触发，不占额度、不受概率门控、每局限 1 次', () => {
  const talk = createTrashTalk({}, () => 0.99); // 概率门控必不过，wololo 不受影响
  const foeFull = [[102, 500], ...tiles(39, 2, 100)];
  assert.equal(talk.maybeSpeak(board({ turn: 60, me: tiles(30, 1, 100), foe: foeFull })), null);
  // 敌 40 格地瞬间掉到 20 格（被截断/隔离结算）
  const crashed = board({ turn: 61, me: tiles(30, 1, 100), foe: [[102, 500], ...tiles(19, 2, 100)] });
  assert.equal(talk.maybeSpeak(crashed), WOLOLO);
  assert.equal(talk.spokenCount(), 0, 'wololo 不占常规额度');
  // 再次暴跌：每局限 1 次，不再触发 wololo
  const crashedAgain = board({ turn: 62, me: tiles(30, 1, 100), foe: [[102, 500]] });
  const line = talk.maybeSpeak(crashedAgain);
  assert.notEqual(line, WOLOLO);
});

test('wololo 不因逐渐失地触发', () => {
  const talk = createTrashTalk({}, pass);
  assert.equal(talk.maybeSpeak(board({ turn: 60, me: tiles(5, 1, 5), foe: [[102, 500], ...tiles(20, 2, 100)] })), null);
  // 单 tick 只丢 5 格，不到暴跌阈值
  assert.equal(talk.maybeSpeak(board({ turn: 61, me: tiles(5, 1, 5), foe: [[102, 500], ...tiles(15, 2, 100)] })), null);
});

test('全局冷却内不重复发言', () => {
  const talk = createTrashTalk({}, pass);
  const s = board({ me: tiles(20, 1, 4), foe: tiles(10, 2, 5) });
  assert.ok(talk.maybeSpeak(s));
  const s2 = board({ turn: 61, me: tiles(20, 1, 4), foe: tiles(10, 2, 5) });
  assert.equal(talk.maybeSpeak(s2), null);
});

test('概率门控：rng 不通过时触发也不说', () => {
  const talk = createTrashTalk({}, () => 0.99);
  const s = board({ me: tiles(40, 1, 20), foe: tiles(10, 2, 10) });
  assert.equal(talk.maybeSpeak(s), null);
});

test('每局次数上限：超过上限后沉默', () => {
  const talk = createTrashTalk({ trashTalkGlobalCd: 30, trashCdLand: 30, trashTalkMaxPerGame: 2 }, pass);
  const at = (turn) => board({ turn, me: tiles(20, 1, 4), foe: tiles(10, 2, 5) });
  assert.ok(talk.maybeSpeak(at(60)));
  assert.ok(talk.maybeSpeak(at(91)));
  assert.equal(talk.maybeSpeak(at(122)), null);
  assert.equal(talk.spokenCount(), 2);
});

test('同档内部轮换、本局不复读', () => {
  const talk = createTrashTalk({ trashTalkGlobalCd: 30, trashCdLand: 30, trashTalkMaxPerGame: 4 }, pass);
  const at = (turn) => board({ turn, me: tiles(20, 1, 4), foe: tiles(10, 2, 5) });
  const first = talk.maybeSpeak(at(60));
  const second = talk.maybeSpeak(at(91));
  assert.ok(first && second);
  assert.notEqual(first, second);
  assert.ok(filledFrom('small', first) && filledFrom('small', second));
});

test('劣势时绝不说垃圾话', () => {
  const talk = createTrashTalk({}, pass);
  const s = board({ me: tiles(5, 1, 5), foe: [[102, 500], ...tiles(30, 2, 100)] });
  assert.equal(talk.maybeSpeak(s), null);
});

test('开局回合下限之前不说话；无敌人时不说话', () => {
  const talk = createTrashTalk({}, pass);
  const early = board({ turn: 30, me: tiles(40, 1, 20), foe: tiles(10, 2, 10) });
  assert.equal(talk.maybeSpeak(early), null);
  const alone = board({ me: tiles(40, 1, 20), foe: [] });
  assert.equal(talk.maybeSpeak(alone), null);
});
