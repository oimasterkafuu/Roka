// 排行榜上榜规则单元测试：直接驱动 dist/auth-store.js 的 UserStore，mock 时间验证以下语义：
//   场景 1：7 天内有比赛（lastGameAt 距今 6 天）在榜。
//   场景 2：7 天无比赛（lastGameAt 距今 8 天）下榜。
//   场景 3：只登录/只上线不续命——lastSeenAt、updatedAt 很近但 lastGameAt 超 7 天的
//           用户不在榜（活跃口径收紧为只认比赛的核心断言）。
//   场景 4：没打过任何对局（ratingGames=0）的用户本就不在榜。
//   场景 5：有效封禁用户即使刚打过比赛也不在榜；封禁过期（惰性判定）后自动回榜。
//   场景 6：旧数据无 lastGameAt 时按 fallback 口径判定——以旧的
//           getLastActiveAt（max(updatedAt, lastSeenAt)）作为一次性过渡初始值。
//   场景 7：下榜用户重新结算一局（applyRatingUpdates 刷新 lastGameAt）后立即回榜。
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
// 固定「当前时间」：2026-09-27 00:00:00 UTC。真实 Date.now() 晚于它，
// applyRatingUpdates/applyBan 写入的真实时间戳在该口径下都视为「新鲜」。
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

  await addUser(store, 'recent_game');
  await addUser(store, 'stale_game');
  await addUser(store, 'login_only');
  await addUser(store, 'never_played');
  await addUser(store, 'banned_active');
  await addUser(store, 'legacy_fresh');
  await addUser(store, 'legacy_stale');
  await addUser(store, 'settle_back');

  // never_played 保持 ratingGames = 0（register 默认）；其余补 ratingGames ≥ 1。
  for (const name of [
    'recent_game',
    'stale_game',
    'login_only',
    'banned_active',
    'legacy_fresh',
    'legacy_stale',
    'settle_back',
  ]) {
    mutateUser(store, name, { ratingGames: 5, rating: 1500 });
  }

  // 场景 1/2：lastGameAt 控制比赛活跃口径。
  mutateUser(store, 'recent_game', { updatedAt: NOW - 30 * DAY_MS, lastGameAt: NOW - 6 * DAY_MS });
  mutateUser(store, 'stale_game', { updatedAt: NOW - 30 * DAY_MS, lastGameAt: NOW - 8 * DAY_MS });

  // 场景 3：只登录/只上线——lastSeenAt 与 updatedAt 都很近，lastGameAt 超 7 天。
  mutateUser(store, 'login_only', {
    updatedAt: NOW - 1 * DAY_MS,
    lastSeenAt: NOW - 1 * DAY_MS,
    lastGameAt: NOW - 8 * DAY_MS,
  });

  // 场景 5：有效封禁用户刚打过比赛。
  mutateUser(store, 'banned_active', { updatedAt: NOW - 1 * DAY_MS, lastGameAt: NOW - 1 * DAY_MS });

  // 场景 6：旧数据无 lastGameAt——fallback 取 max(updatedAt, lastSeenAt)。
  mutateUser(store, 'legacy_fresh', { updatedAt: NOW - 6 * DAY_MS, lastSeenAt: NOW - 6 * DAY_MS });
  mutateUser(store, 'legacy_stale', { updatedAt: NOW - 8 * DAY_MS, lastSeenAt: NOW - 8 * DAY_MS });

  // 场景 7：先置于下榜状态。
  mutateUser(store, 'settle_back', { updatedAt: NOW - 30 * DAY_MS, lastGameAt: NOW - 8 * DAY_MS });

  console.log('场景 1/2/4/6：比赛口径在榜/下榜、无对局不在榜、旧数据 fallback');
  let board = store.listTopRated(10, NOW).map((e) => e.username);
  check('6 天内有比赛的用户在榜', board.includes('recent_game'));
  check('8 天无比赛的用户下榜', !board.includes('stale_game'));
  check('没打过对局的用户不在榜', !board.includes('never_played'));
  check('旧数据 fallback 活跃 6 天的用户在榜', board.includes('legacy_fresh'));
  check('旧数据 fallback 活跃 8 天的用户下榜', !board.includes('legacy_stale'));

  console.log('场景 3：只登录/只上线不续命（lastSeenAt/updatedAt 近、lastGameAt 超 7 天）');
  check('只登录/只上线的用户不在榜', !board.includes('login_only'));
  // 再真的走一遍登录 + 上线路径，确认仍不回榜。
  await store.rotateSession('login_only');
  await store.setLastSeenAt('login_only', NOW);
  board = store.listTopRated(10, NOW).map((e) => e.username);
  check('重新登录 + 上线后仍不在榜', !board.includes('login_only'));

  console.log('场景 5：有效封禁不上榜，过期自动回榜');
  await store.applyBan('banned_active', Date.now() + DAY_MS, { type: 'manual', reason: '测试封禁' });
  board = store.listTopRated(10, NOW).map((e) => e.username);
  check('有效封禁用户即使刚打过比赛也不在榜', !board.includes('banned_active'));
  // 模拟封禁到期：getBanStatus 惰性解除后自动回榜。
  mutateUser(store, 'banned_active', { bannedUntil: Date.now() - 1000 });
  board = store.listTopRated(10, NOW).map((e) => e.username);
  check('封禁过期后自动回榜', board.includes('banned_active'));

  console.log('场景 7：下榜用户重新结算一局后立即回榜');
  check('结算前 settle_back 下榜', !board.includes('settle_back'));
  await store.applyRatingUpdates([{ username: 'settle_back', delta: 10 }]);
  board = store.listTopRated(10, NOW).map((e) => e.username);
  check('重新结算后回榜', board.includes('settle_back'));

  console.log('边界：lastGameAt 距今恰好 7 天（== 阈值）下榜');
  mutateUser(store, 'recent_game', { lastGameAt: NOW - LEADERBOARD_INACTIVITY_MS });
  board = store.listTopRated(10, NOW).map((e) => e.username);
  check('恰好 7 天无比赛下榜', !board.includes('recent_game'));

  await rm(dataDir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} 项断言失败`);
    process.exit(1);
  }
  console.log('\n全部排行榜上榜规则测试通过');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
