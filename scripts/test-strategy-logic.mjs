// 策略逻辑单元测试：用合成棋盘（1×m 走廊）直接驱动真实的 bot/ 纯函数决策
// 模块（board.buildContext + offense.planOffense），逐 tick 复现跨 tick 决策
// 状态（state.plan / planCooldown / standoffGate 等），针对两类已修复的行为
// 缺陷做回归：
//   场景 1（触发即攻）：走廊上集结兵力明显优势时打击计划应立即开打，不屯兵。
//   场景 2（集结期入口纪律）：集结中的入口格不出兵切断——修复前入口顺手
//     切断把自己抽空、入口随即易位，输送纵队被新入口反复改道（峡谷回廊
//     「来回调兵」的根因之一）。
//   场景 3（对峙超时 + 重集结闸门）：缺口长期不变的僵死集结必须解散并停止
//     向该点调兵；局势无实质改善前不为同一目标再集结；优势明显后立即开打。
//   场景 4（爆发期自然增长）：集结期需求因爆发期路径敌格自然增兵（每格
//     +1/tick）上升时不得误判为「敌方增援」弃打——误判弃打换目标是走廊
//     折返空耗的根因之一。
// 成功 exit 0，失败 exit 1。

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'bot-template', 'simple-strategy-bot', 'index.js'));
const { buildContext } = require('./bot/board');
const { planOffense } = require('./bot/offense');

/* ---------- 合成棋盘工具 ---------- */

const NEUTRAL = 200;
const MY_CROWN = 101; // 100 + playerId(1)
const MY_PLAIN = 1;
const ENEMY_PLAIN = 2; // owner 2
const ENEMY_CROWN = 102; // 100 + 2

/** 1×m 走廊棋盘；cells = [{code, army}]（长度 m）。 */
function makeState(cells, turn) {
  const n = 1;
  const m = cells.length;
  return {
    n,
    m,
    gridType: cells.map((c) => c.code),
    armyCnt: cells.map((c) => c.army),
    isolated: new Array(n * m).fill(0),
    playerId: 1,
    turn,
    teams: new Map([
      [1, 1],
      [2, 2],
    ]),
    allowTeam: false,
    deadPlayers: new Set(),
    plan: null,
    planCooldown: new Map(),
    standoffGate: new Map(),
    lastActiveThreatTurn: -1000,
    breakthroughIdx: -1,
  };
}

const cell = (code, army) => ({ code, army });
const neutralRow = (count) => Array.from({ length: count }, () => cell(NEUTRAL, 0));

/** 调一次进攻决策（无威胁清单），返回 { candidates, focus }。 */
function decide(state) {
  const ctx = buildContext(state);
  return planOffense(ctx, state, []);
}

const isStrikeFrom = (cand, y) =>
  cand.tag === 'strike' && cand.op.payload.x === 0 && cand.op.payload.y === y;
const isAttackFrom = (cand, y) =>
  cand.op.kind === 'attack' && cand.op.payload.x === 0 && cand.op.payload.y === y;

/* ---------- 断言 ---------- */

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${name}${detail ? ` (${detail})` : ''}`);
  }
}

/* ---------- 场景 1：明显优势立即开打（触发即攻） ---------- */
function testStrikeWhenSuperior() {
  console.log('场景 1：走廊上兵力明显优势时立即开打');
  const state = makeState(
    [cell(MY_CROWN, 300), ...neutralRow(4), cell(ENEMY_CROWN, 30)],
    60,
  );
  const { candidates, focus } = decide(state);
  check('产出 strike 候选（从主城起步）', candidates.some((c) => isStrikeFrom(c, 0)));
  check('不再集结（focus 为空）', focus === null);
  check('打击目标指向敌方主城', state.plan?.targetIdx === 5);
}

/* ---------- 场景 2：集结期入口格不出兵切断 ---------- */
function testGatheringEntryDiscipline() {
  console.log('场景 2：集结期入口纪律（入口不顺手切断、焦点不跳变）');
  const state = makeState(
    [
      cell(MY_CROWN, 600),
      cell(MY_PLAIN, 350), // 入口：贴着一个吃得下的敌格（50）
      cell(ENEMY_PLAIN, 50),
      ...neutralRow(6),
      cell(ENEMY_CROWN, 400),
    ],
    60,
  );
  const first = decide(state);
  check('立打击计划并以 idx1 为集结入口', state.plan?.targetIdx === 9 && first.focus?.idx === 1);
  check('计划进入集结期标记', state.plan?.gathering === true);
  // 第二 tick：入口（350 兵）贴着可吃的敌格（50 兵）——修复前会出 cut 把自己抽空。
  const second = decide(state);
  check(
    '入口格不出兵（无 idx1 发出的 op）',
    second.candidates.every((c) => !isAttackFrom(c, 1)),
    JSON.stringify(second.candidates.map((c) => c.op.payload)),
  );
  check('集结焦点保持在 idx1（不跳变）', second.focus?.idx === 1);
}

/* ---------- 场景 3：对峙超时解散 + 重集结闸门 + 改善后开打 ---------- */
function testStandoffTimeoutAndGate() {
  console.log('场景 3：僵死对峙超时解散、闸门阻止再集结、优势明显后触发即攻');
  const cells = [
    cell(MY_CROWN, 100),
    cell(MY_CROWN, 1000), // 入口皇冠（半兵推 499，差开打线一线，缺口恒定）
    ...neutralRow(8),
    cell(ENEMY_PLAIN, 400),
    cell(ENEMY_CROWN, 200),
  ];
  const state = makeState(cells, 60);

  const first = decide(state);
  check('集结计划形成（焦点 = 入口 idx1）', first.focus?.idx === 1 && state.plan?.targetIdx === 11);

  // 静态棋盘驱动 80 tick：缺口恒定（双方都不增长），修复前将无限集结下去。
  let abandonTurn = null;
  for (let i = 1; i <= 80; i += 1) {
    state.turn = 60 + i;
    decide(state);
    if (state.plan === null && abandonTurn === null) {
      abandonTurn = state.turn;
      break;
    }
  }
  check('对峙超时后解散集结（约 50 tick 内）', abandonTurn !== null && abandonTurn <= 115, `abandonTurn=${abandonTurn}`);
  check('目标进入长冷却', (state.planCooldown.get(11) ?? 0) >= state.turn + 200);
  check('登记重集结闸门', typeof state.standoffGate.get(11) === 'number');

  // 解散后不得再向原集结点调兵。
  const after = decide(state);
  check('解散后焦点不再是原入口', after.focus?.idx !== 1);

  // 冷却结束后局势不变：闸门拦下，不得原地重演集结。
  state.turn = (state.planCooldown.get(11) ?? state.turn) + 10;
  const regather = decide(state);
  check('冷却结束后闸门阻止再集结（无计划）', state.plan === null && regather.focus?.idx !== 1);

  // 局势实质改善（入口兵力翻倍、推兵过开打线）：立即触发进攻。
  state.armyCnt[1] = 2000;
  const strike = decide(state);
  check('优势明显后立即开打（strike 从入口发出）', strike.candidates.some((c) => isStrikeFrom(c, 1)));
}

/* ---------- 场景 4：爆发期路径敌格自然增长不误判增援弃打 ---------- */
function testBurstNaturalGrowth() {
  console.log('场景 4：爆发期路径敌格自然增兵不误判为敌方增援');
  const state = makeState(
    [
      cell(MY_CROWN, 50),
      cell(MY_PLAIN, 150),
      cell(ENEMY_PLAIN, 8),
      cell(ENEMY_PLAIN, 8),
      cell(ENEMY_PLAIN, 8),
      cell(ENEMY_PLAIN, 8),
      cell(ENEMY_PLAIN, 8),
      cell(ENEMY_PLAIN, 8),
      cell(ENEMY_PLAIN, 8),
      cell(ENEMY_CROWN, 40),
    ],
    26,
  );
  // 进行中的打击计划（tick 26 立），第一拍记录需求基线。
  state.plan = { targetIdx: 9, owner: 2, headIdx: 1 };
  decide(state);
  const baseRequired = state.plan?.startRequired;
  check('需求基线已记录', typeof baseRequired === 'number');

  // 快进 8 tick（26→34，全程爆发期）：路径上 7 个敌方普通格各 +8、皇冠 +8，
  // 全部属于自然增长；旧口径只算皇冠 +1/tick，会把 +64 误判成大幅增援弃打。
  state.turn = 34;
  for (let i = 2; i <= 8; i += 1) {
    state.armyCnt[i] += 8;
  }
  state.armyCnt[9] += 8;
  decide(state);
  check('未误判增援弃打（计划存续）', state.plan !== null && state.plan.targetIdx === 9);
  check('目标未进入冷却', state.planCooldown.get(9) === undefined);
}

/* ---------- 主流程 ---------- */

function main() {
  testStrikeWhenSuperior();
  testGatheringEntryDiscipline();
  testStandoffTimeoutAndGate();
  testBurstNaturalGrowth();
  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`);
    process.exit(1);
  }
  console.log('\n全部策略逻辑测试通过');
}

main();
