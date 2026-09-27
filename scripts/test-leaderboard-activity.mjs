// 排行榜不活跃下榜过滤单元测试：直接驱动 dist/auth-store.js 的 UserStore，
// mock 时间验证以下语义（issue：排行榜 7 天不活跃下榜，重新活跃即回榜）：
//   场景 1：最后活动距今 6 天（< 7 天阈值）仍在榜。
//   场景 2：最后活动距今 8 天（≥ 7 天阈值）下榜。
//   场景 3：下榜用户重新登录（rotateSession 刷新 updatedAt + setLastSeenAt
//           刷新 lastSeenAt）后立即回榜，无需重新开一局。
//   场景 4：没打过任何对局（ratingGames=0）的用户本就不在榜。
//   场景 5：lastSeenAt 与 updatedAt 取较大者——对局结算只刷 updatedAt、
//           socket 上下线只刷 lastSeenAt，两者任一新鲜都算活跃（bot 天天
//           对局经结算保持活跃即此路径）。
// 成功 exit 0，失败 exit 1。
// 运行前需先 `pnpm run build`（本脚本读取 dist 产物）。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const { UserStore, LEADERBOARD_INACTIVITY_MS } = require('./dist/auth-store.js');

const DAY_MS = 24 * 3600 * 1000;
// 固定「当前时间」：2026-09-27 00:00:00 UTC。
const NOW = Date.UTC(2026, 8, 27);

let failures = 0;
const check = (label, condition) => {
  if (condition) {
    console.log(`  ok - ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${label}`);
  }
};

/** 造一个最小合法用户并写入 store。 */
async function addUser(store, username) {
  await store.register(username, 'password1');
}

/** 从 store 内部拿用户记录（UserStore 未暴露写时间字段的接口，测试直接改内部状态）。 */
function mutateUser(store, username, patch) {
  const key = username.trim().toLowerCase();
  const user = store.usersByKey.get(key);
  Object.assign(user, patch);
}

async function main() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'roka-leaderboard-test-'));
  const store = new UserStore(dataDir);
  await store.ensureReady();

  // 场景 1/2/3/4 的用户：updatedAt 均设为 NOW - 30 天（注册时间），
  // lastSeenAt 控制「最后活动时间」。
  await addUser(store, 'active_six');
  await addUser(store, 'inactive_eight');
  await addUser(store, 'relogin_back');
  await addUser(store, 'never_played');
  await addUser(store, 'settled_only');

  // 没打过对局的用户：ratingGames = 0（register 默认 0，无需改）。
  // 其余用户补 ratingGames ≥ 1（模拟打过对局）。
  for (const name of ['active_six', 'inactive_eight', 'relogin_back', 'settled_only']) {
    mutateUser(store, name, { ratingGames: 5, rating: 1500 });
  }

  // 场景 5 的对照组：settled_only 无 lastSeenAt，仅靠 updatedAt（对局结算路径）。
  mutateUser(store, 'active_six', { updatedAt: NOW - 30 * DAY_MS, lastSeenAt: NOW - 6 * DAY_MS });
  mutateUser(store, 'inactive_eight', { updatedAt: NOW - 30 * DAY_MS, lastSeenAt: NOW - 8 * DAY_MS });
  mutateUser(store, 'relogin_back', { updatedAt: NOW - 30 * DAY_MS, lastSeenAt: NOW - 8 * DAY_MS });
  mutateUser(store, 'settled_only', { updatedAt: NOW - 6 * DAY_MS });

  console.log('场景 1/2/4/5：6 天在榜、8 天下榜、无对局不在榜、仅结算活跃仍在榜');
  let board = store.listTopRated(10, NOW).map((e) => e.username);
  check('活跃 6 天的用户在榜', board.includes('active_six'));
  check('活跃 8 天的用户下榜', !board.includes('inactive_eight'));
  check('没打过对局的用户不在榜', !board.includes('never_played'));
  check('仅靠对局结算（updatedAt 6 天前）的用户在榜', board.includes('settled_only'));

  console.log('场景 3：重新登录（rotateSession + setLastSeenAt）后立即回榜');
  await store.rotateSession('relogin_back');
  await store.setLastSeenAt('relogin_back');
  board = store.listTopRated(10, NOW).map((e) => e.username);
  check('重新登录后回榜', board.includes('relogin_back'));

  console.log('边界：距今恰好 7 天（== 阈值）下榜');
  mutateUser(store, 'active_six', { lastSeenAt: NOW - LEADERBOARD_INACTIVITY_MS });
  board = store.listTopRated(10, NOW).map((e) => e.username);
  check('恰好 7 天无活动下榜', !board.includes('active_six'));

  await rm(dataDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`);
    process.exit(1);
  }
  console.log('\n全部排行榜不活跃过滤测试通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
