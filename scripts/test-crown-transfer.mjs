// 队友间主城转让（issue #81）单元冒烟：直接驱动 dist/game-engine.js 的 GameEngine，
// 运行时访问 TS private 字段布置棋盘，验证以下语义：
//   场景 1：不能向敌人的主城发起转让（静默忽略）。
//   场景 2：队友只剩最后一座主城时拒绝转让（请求方收到提示）。
//   场景 3：队友有 ≥2 座主城时请求成功——登记待处理请求并向拥有者下发
//           crown_transfer_request 回调。
//   场景 4：同一拥有者同时最多一个待处理请求（防刷）。
//   场景 5：拥有者拒绝后请求方收到提示，归属不变。
//   场景 6：拥有者同意后主城改属请求方（建筑保持 -2、兵力不变），并记录回放 op。
//   场景 7：同意后拥有者仍保有 1 座主城；对其最后一座再请求被拒绝。
//   场景 8：接受时重新校验——目标已不再是该队友主城则失败并提示。
//   场景 9：对局已结束（finished）时请求静默忽略。
// 成功 exit 0，失败 exit 1。
// 运行前需先 `pnpm run build`（本脚本读取 dist 产物）。

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const { GameEngine } = require('./dist/game-engine.js');

let failures = 0;
const check = (label, condition) => {
  if (condition) {
    console.log(`  ok - ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${label}`);
  }
};

const SIDS = ['sidAlice', 'sidBob', 'sidCarol'];

/** 造一个 3 人引擎：alice/bob 同队（1 队），carol 单独（2 队）；捕获聊天与转让请求回调。 */
async function createEngine() {
  const chatLog = [];
  const transferRequests = [];
  const engine = await GameEngine.create(
    {
      speed: 1,
      width_ratio: 0.5,
      height_ratio: 0.5,
      swamp_ratio: 0.1,
      map_token: 'crown-transfer-test',
      map_mode: 'random',
      map_region: 'china',
      allow_team: true,
      fog: false,
      map_size: 'normal',
      player_names: ['alice', 'bob', 'carol'],
      player_teams: [1, 1, 2],
    },
    SIDS,
    ['idAlice', 'idBob', 'idCarol'],
    'test-crown-transfer',
    {
      update: () => undefined,
      emitInitMap: () => undefined,
      chatMessage: (id, scope, sender, color, text) => {
        chatLog.push({ id, scope, text });
      },
      crownTransferRequest: (sid, data) => {
        transferRequests.push({ sid, ...data });
      },
      endGame: () => undefined,
      md5: (input) => input,
      replayStore: { saveReplay: async () => '' },
    },
  );
  return { engine, chatLog, transferRequests };
}

/** 给 ownerId（1 基）在任意普通空地上放一座主城，返回坐标。 */
function plantCrown(engine, ownerId) {
  for (let i = 0; i < engine.n; i += 1) {
    for (let j = 0; j < engine.m; j += 1) {
      if (engine.gridType[i][j] === 0 && engine.owner[i][j] === 0) {
        engine.gridType[i][j] = -2;
        engine.owner[i][j] = ownerId;
        engine.armyCnt[i][j] = 5;
        return [i, j];
      }
    }
  }
  throw new Error('没有可放主城的中立空地。');
}

const lastChatTo = (chatLog, sid) => {
  const hits = chatLog.filter((entry) => entry.scope === 'sid' && entry.id === sid);
  return hits.length > 0 ? hits[hits.length - 1].text : '';
};

async function main() {
  const { engine, chatLog, transferRequests } = await createEngine();
  const [aliceCrown] = [engine.generals[0]];
  const [bobCrownX, bobCrownY] = engine.generals[1];
  const [carolCrownX, carolCrownY] = engine.generals[2];
  check('开局每人一座主城', engine.countCrowns(1) === 1 && engine.countCrowns(2) === 1 && engine.countCrowns(3) === 1);
  check('初始选中 alice 主城坐标有效', Array.isArray(aliceCrown) && aliceCrown[0] >= 0);

  // 场景 1：向敌人 carol 的主城请求 → 静默忽略。
  engine.requestCrownTransfer('sidAlice', carolCrownX, carolCrownY);
  check('场景 1：敌方主城请求被忽略（无提示/无回调/无待处理）',
    chatLog.length === 0 && transferRequests.length === 0 && engine.crownTransferPending.size === 0);

  // 场景 2：bob 只有最后一座主城 → 拒绝并提示请求方。
  engine.requestCrownTransfer('sidAlice', bobCrownX, bobCrownY);
  check('场景 2：最后一座主城不可转让（提示请求方）',
    lastChatTo(chatLog, 'sidAlice').includes('最后一座主城') && engine.crownTransferPending.size === 0);

  // 场景 3：给 bob 放第二座主城后再请求 → 成功登记并回调 bob。
  const [bx, by] = plantCrown(engine, 2);
  engine.requestCrownTransfer('sidAlice', bx, by);
  check('场景 3：请求成功登记待处理（键为拥有者 bob）', engine.crownTransferPending.has(1));
  check('场景 3：向 bob 下发 crown_transfer_request 回调',
    transferRequests.length === 1 && transferRequests[0].sid === 'sidBob' &&
      transferRequests[0].from === 'alice' && transferRequests[0].x === bx && transferRequests[0].y === by);
  check('场景 3：请求方收到等待确认提示', lastChatTo(chatLog, 'sidAlice').includes('等待对方确认'));

  // 场景 4：同一拥有者已有待处理请求 → 防刷拒绝。
  engine.requestCrownTransfer('sidAlice', bobCrownX, bobCrownY);
  check('场景 4：重复请求被防刷拦截', lastChatTo(chatLog, 'sidAlice').includes('未处理'));

  // 场景 5：无待处理请求的玩家答复 → 无效；bob 拒绝 → 提示请求方，归属不变。
  engine.replyCrownTransfer('sidCarol', true);
  check('场景 5：无待处理请求的答复无效', engine.crownTransferPending.has(1) && engine.owner[bx][by] === 2);
  engine.replyCrownTransfer('sidBob', false);
  check('场景 5：拒绝后请求方收到提示且归属不变',
    lastChatTo(chatLog, 'sidAlice').includes('拒绝') && engine.owner[bx][by] === 2 &&
      engine.crownTransferPending.size === 0);

  // 场景 6/7：重新请求并同意 → 主城改属 alice（建筑保持 -2、兵力不变），记回放 op。
  engine.requestCrownTransfer('sidAlice', bx, by);
  engine.replyCrownTransfer('sidBob', true);
  check('场景 6：同意后主城改属请求方', engine.owner[bx][by] === 1);
  check('场景 6：主城建筑保留（gridType 仍为 -2）且兵力不变',
    engine.gridType[bx][by] === -2 && engine.armyCnt[bx][by] === 5);
  check('场景 6：回放记录该回合转让 op', engine.replayTurnTransfers[0].get(engine.turn + 1)?.x === bx);
  check('场景 6：房间广播转让系统消息',
    chatLog.some((entry) => entry.scope === 'room' && entry.text.includes('转让给了队友')));
  check('场景 7：转让后 bob 仍保有 1 座主城', engine.countCrowns(2) === 1);
  engine.requestCrownTransfer('sidAlice', bobCrownX, bobCrownY);
  check('场景 7：对 bob 最后一座主城再请求被拒', lastChatTo(chatLog, 'sidAlice').includes('最后一座主城'));

  // 场景 8：请求后目标易主（被敌方攻陷简化为直接改归属）→ 接受时重校验失败。
  const [cx, cy] = plantCrown(engine, 2);
  engine.requestCrownTransfer('sidAlice', cx, cy);
  engine.owner[cx][cy] = 3;
  engine.replyCrownTransfer('sidBob', true);
  check('场景 8：目标已易主时接受失败并提示请求方',
    engine.owner[cx][cy] === 3 && lastChatTo(chatLog, 'sidAlice').includes('转让失败'));

  // 场景 9：对局已结束 → 请求静默忽略。
  engine.finished = true;
  const chatCount = chatLog.length;
  engine.requestCrownTransfer('sidAlice', cx, cy);
  check('场景 9：对局结束后请求静默忽略',
    chatLog.length === chatCount && engine.crownTransferPending.size === 0);

  if (failures > 0) {
    console.error(`\n${failures} 项检查失败。`);
    process.exit(1);
  }
  console.log('\n全部检查通过。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
