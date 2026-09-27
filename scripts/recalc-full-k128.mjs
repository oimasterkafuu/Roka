#!/usr/bin/env node
/**
 * 一次性脚本：全量重算历史对局 rating（K=128）。不入库、不提交。
 *
 * 用法：
 *   node scripts/recalc-full-k128.mjs            # dry-run（默认）：只打印报告，不写任何文件
 *   node scripts/recalc-full-k128.mjs --apply    # 重算并写回 users.bin（写前强制带时间戳备份）
 *   node scripts/recalc-full-k128.mjs --data-dir /path/to/data   # 自测用：覆盖数据目录
 *
 * 数据路径（服务器上写死，可用 --data-dir 覆盖）：
 *   <dataDir>/replays/index.bin   v8.deserialize 的对局索引（ReplayListItem[]：id/time/rank/turn）
 *   <dataDir>/replays/<id>.rpl    v8.deserialize(brotliDecompress(...))，ops-v1 操作流，meta 含
 *                                 player_names / player_teams / map_mode 等
 *   <dataDir>/users.bin           v8.deserialize(brotliDecompress(...))，{ users: StoredUser[] }
 *
 * 结算公式逐行对齐 src/server/lobby-service.ts applyGameResult + src/auth-store.ts
 * applyRatingUpdates（均为 K=128 版本）：
 *   - 队伍名次 = 队内最好成员名次在队伍间的位次（teamPlace，1..T）
 *   - 队伍强度 = n³ · Σ 10^(r/400)，队伍分 = 400 · log10(强度)，单人队退化为成员分
 *   - score = (T - place) / (T - 1)；expected = 平均 1/(1+10^((R_other-R_team)/400))
 *   - delta = 128 · (score - expected)，队内成员同 delta
 *   - 结算顺序 = 时间正序（线上即按对局结束先后结算）；同秒对局的相互顺序线上不可考，
 *     这里按 (time, id) 稳定排序，报告中注明。
 *   - 成员分更新：rating = round((rating + delta) * 10) / 10，ratingGames += 1，
 *     ratingHistory 追加 { t, r = 显示分 }（显示分 = max(0, round(rating - 1200/2^games))），
 *     历史长度截断至 1000。t 取对局时间（约等于线上结算时的 Date.now()）。
 *
 * 跳过（不结算）的对局类型——与线上 applyGameResult 的触发条件一致：
 *   1. 参赛（非观战）玩家 < 2：result.length < 2 直接 return。
 *   2. 队伍数 < 2（全员同队）：teams.length < 2 直接 return。
 *   3. 观战席（team === 0）本就不在 leaderboard / GameResultEntry 中，天然不结算。
 *   4. users.bin 中不存在的 uid：applyRatingUpdates 逐条丢弃该 update
 *      （但队伍强度计算时 getRating 对其取 DEFAULT_RATING=1200，本脚本同样处理）。
 *   5. index.bin 有记录但 .rpl 缺失/损坏/meta 不完整：无法重建结算输入，跳过并计入报告
 *      （线上 saveHistory 先于 applyGameResult await，理论上不存在此类对局）。
 *
 * 风险：
 *   - dry-run 是默认模式，不写盘；--apply 才写 users.bin。
 *   - --apply 前会把 users.bin 复制为 users.bin.recalc-backup-<时间戳>。
 *   - 运行中的服务端会 persist users.bin，可能覆盖本脚本的写入：--apply 前请先停服，
 *     写入完成并校验后再启动。
 *   - 全量重算会重置所有用户的 rating=1200 / ratingGames=0 / ratingHistory=[] 后重放；
 *     未出现在任何有效对局中的用户也会回到初始值（这正是“全量重算”的语义）。
 */

import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { brotliCompress, brotliDecompress, constants as zlibConstants } from 'node:zlib';

const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

// ---- 与 src/server/lobby-service.ts / src/auth-store.ts 对齐的常量 ----
const RATING_K = 128; // lobby-service.ts RATING_K
const DEFAULT_RATING = 1200; // auth-store.ts DEFAULT_RATING
const RATING_HISTORY_MAX = 1000; // auth-store.ts RATING_HISTORY_MAX

// auth-store.ts toDisplayRating（展示分，仅用于 ratingHistory 的 r 字段）
const toDisplayRating = (rating, ratingGames) => {
  if (!Number.isFinite(rating) || !Number.isFinite(ratingGames) || ratingGames <= 0) {
    return 0;
  }
  const shift = DEFAULT_RATING / 2 ** ratingGames;
  return Math.max(0, Math.round(rating - shift));
};

// auth-store.ts UserStore.normalize
const normalize = (username) => String(username).trim().toLowerCase();

// auth-store.ts encodeUserFileBinary：v8 serialize + brotli(quality 6)，写盘格式以此为准
const encodeUserFileBinary = async (value) => {
  const raw = serialize(value);
  return brotliCompressAsync(raw, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
  });
};

const decodeBrotliV8 = async (content) => deserialize(await brotliDecompressAsync(content));

// ---- 参数 ----
const args = process.argv.slice(2);
const applyMode = args.includes('--apply');
const dataDirIdx = args.indexOf('--data-dir');
const DATA_DIR = dataDirIdx >= 0 ? path.resolve(args[dataDirIdx + 1]) : '/root/roka/data';
const REPLAY_DIR = path.join(DATA_DIR, 'replays');
const INDEX_BIN = path.join(REPLAY_DIR, 'index.bin');
const USERS_BIN = path.join(DATA_DIR, 'users.bin');

const main = async () => {
  // ---- 读取用户存储（原样保留，便于报告旧值；重放在副本状态上进行）----
  const userFile = await decodeBrotliV8(await readFile(USERS_BIN));
  if (!userFile || !Array.isArray(userFile.users)) {
    throw new Error('users.bin 结构无效（缺少 users 数组）。');
  }
  const users = userFile.users;
  const usersByKey = new Map();
  for (const user of users) {
    usersByKey.set(normalize(user.username), user);
  }
  // 旧值快照（报告用）
  const before = new Map();
  for (const user of users) {
    before.set(normalize(user.username), {
      rating: user.rating ?? DEFAULT_RATING,
      ratingGames: user.ratingGames ?? 0,
      historyLength: Array.isArray(user.ratingHistory) ? user.ratingHistory.length : 0,
    });
  }

  // ---- 全量重算：重置所有用户到初始状态 ----
  for (const user of users) {
    user.rating = DEFAULT_RATING;
    user.ratingGames = 0;
    user.ratingHistory = [];
  }
  // 与 auth-store.getRating 一致：缺失用户按 DEFAULT_RATING 参与队伍强度计算
  const ratingOf = (uid) => usersByKey.get(normalize(uid))?.rating ?? DEFAULT_RATING;

  // ---- 读取对局索引并按时间正序 ----
  const indexItems = deserialize(await readFile(INDEX_BIN));
  if (!Array.isArray(indexItems)) {
    throw new Error('index.bin 结构无效（不是数组）。');
  }
  const games = [...indexItems].sort((a, b) => a.time - b.time || String(a.id).localeCompare(String(b.id)));

  const stats = {
    total: games.length,
    settled: 0,
    skippedMissingReplay: 0,
    skippedTooFewPlayers: 0,
    skippedSingleTeam: 0,
    totalUpdates: 0, // 实际应用的成员 update 条数（= 所有用户 ratingGames 之和，自检用）
    maxAbsDeltaSumPerGame: 0, // 每场 Σdelta 绝对值的最大值（应≈0，零和自检）
    unknownUids: new Map(), // 结算中出现但 users.bin 不存在的 uid -> 涉及场数
  };

  // ---- 逐场重放结算（逐行对齐 applyGameResult / applyRatingUpdates）----
  for (const item of games) {
    let replay;
    try {
      replay = await decodeBrotliV8(await readFile(path.join(REPLAY_DIR, `${item.id}.rpl`)));
    } catch {
      stats.skippedMissingReplay += 1;
      console.warn(`[skip] ${item.id}: 回放文件缺失或无法解码`);
      continue;
    }
    const meta = replay?.meta;
    if (
      !meta ||
      !Array.isArray(meta.player_names) ||
      !Array.isArray(meta.player_teams) ||
      meta.player_names.length !== meta.player_teams.length
    ) {
      stats.skippedMissingReplay += 1;
      console.warn(`[skip] ${item.id}: meta 不完整（player_names/player_teams）`);
      continue;
    }

    // 重建 GameResultEntry[]：等价于 buildGameResult —— leaderboard 只含 team !== 0
    // 的参赛玩家，rank 取自 index 的 rank 数组（即 buildFinalRank 的 uid 顺序）。
    const rankByUid = new Map((Array.isArray(item.rank) ? item.rank : []).map((uid, i) => [uid, i + 1]));
    const result = [];
    meta.player_names.forEach((uid, i) => {
      const team = meta.player_teams[i];
      if (team !== 0) {
        result.push({ uid, team, rank: rankByUid.get(uid) ?? result.length + 1 });
      }
    });
    // rank 兜底说明：线上为 rankByUid.get(uid) ?? leaderboard.length；leaderboard 长度
    // 即参赛人数。这里用 result 最终长度更精确，先补一遍：
    const playingCount = result.length;
    for (const entry of result) {
      if (entry.rank > playingCount) {
        entry.rank = playingCount;
      }
    }

    // applyGameResult: if (result.length < 2) return;
    if (result.length < 2) {
      stats.skippedTooFewPlayers += 1;
      continue;
    }
    const teamRank = new Map();
    for (const entry of result) {
      const prev = teamRank.get(entry.team);
      if (prev === undefined || entry.rank < prev) {
        teamRank.set(entry.team, entry.rank);
      }
    }
    const teams = [...teamRank.keys()];
    // applyGameResult: if (teams.length < 2) return;
    if (teams.length < 2) {
      stats.skippedSingleTeam += 1;
      continue;
    }

    const teamPlace = new Map();
    [...teams]
      .sort((a, b) => (teamRank.get(a) ?? 0) - (teamRank.get(b) ?? 0))
      .forEach((team, index) => teamPlace.set(team, index + 1));

    const teamRating = new Map();
    for (const team of teams) {
      const members = result.filter((entry) => entry.team === team);
      const strength =
        members.length ** 3 * members.reduce((sum, entry) => sum + 10 ** (ratingOf(entry.uid) / 400), 0);
      teamRating.set(team, 400 * Math.log10(strength));
    }

    const updates = [];
    let deltaSum = 0;
    for (const team of teams) {
      const rank = teamPlace.get(team) ?? teams.length;
      const score = (teams.length - rank) / (teams.length - 1);
      let expected = 0;
      for (const other of teams) {
        if (other === team) {
          continue;
        }
        expected += 1 / (1 + 10 ** (((teamRating.get(other) ?? 1200) - (teamRating.get(team) ?? 1200)) / 400));
      }
      expected /= teams.length - 1;
      const delta = RATING_K * (score - expected);
      deltaSum += delta;
      for (const entry of result) {
        if (entry.team === team) {
          updates.push({ username: entry.uid, delta });
        }
      }
    }
    stats.maxAbsDeltaSumPerGame = Math.max(stats.maxAbsDeltaSumPerGame, Math.abs(deltaSum));

    // applyRatingUpdates：用户不存在或 delta 非有限值则丢弃该条
    const settledAt = item.time * 1000; // 约等于线上结算时的 Date.now()
    for (const update of updates) {
      const user = usersByKey.get(normalize(update.username));
      if (!user) {
        stats.unknownUids.set(update.username, (stats.unknownUids.get(update.username) ?? 0) + 1);
        continue;
      }
      if (!Number.isFinite(update.delta)) {
        continue;
      }
      user.rating = Math.round(((user.rating ?? DEFAULT_RATING) + update.delta) * 10) / 10;
      user.ratingGames = (user.ratingGames ?? 0) + 1;
      if (!Array.isArray(user.ratingHistory)) {
        user.ratingHistory = [];
      }
      user.ratingHistory.push({ t: settledAt, r: toDisplayRating(user.rating, user.ratingGames) });
      if (user.ratingHistory.length > RATING_HISTORY_MAX) {
        user.ratingHistory = user.ratingHistory.slice(-RATING_HISTORY_MAX);
      }
      user.updatedAt = settledAt;
      stats.totalUpdates += 1;
    }
    stats.settled += 1;
  }

  // ---- 自检 ----
  const ratingGamesSum = users.reduce((sum, user) => sum + (user.ratingGames ?? 0), 0);
  const checkOk = ratingGamesSum === stats.totalUpdates;

  // ---- 报告 ----
  const affected = [];
  for (const user of users) {
    const key = normalize(user.username);
    const old = before.get(key);
    const next = { rating: user.rating ?? DEFAULT_RATING, ratingGames: user.ratingGames ?? 0 };
    if (old.rating !== next.rating || old.ratingGames !== next.ratingGames) {
      affected.push({
        username: user.username,
        oldRating: old.rating,
        newRating: next.rating,
        oldGames: old.ratingGames,
        newGames: next.ratingGames,
        delta: Math.round((next.rating - old.rating) * 10) / 10,
        historyLength: user.ratingHistory.length,
      });
    }
  }
  affected.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  console.log('==== Roka 全量 rating 重算报告（K=128） ====');
  console.log(`模式: ${applyMode ? 'APPLY（写盘）' : 'dry-run（不写盘）'}`);
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(
    `对局: 共 ${stats.total} 场；结算 ${stats.settled} 场；跳过 ` +
      `${stats.total - stats.settled} 场（回放缺失/损坏 ${stats.skippedMissingReplay}，` +
      `参赛人数<2 ${stats.skippedTooFewPlayers}，队伍数<2 ${stats.skippedSingleTeam}）`,
  );
  console.log(`用户数: ${users.length}；受影响用户: ${affected.length}`);
  console.log(
    `自检: Σ ratingGames = ${ratingGamesSum}，实际应用 update 数 = ${stats.totalUpdates} ` +
      `=> ${checkOk ? 'OK' : '不一致！'}`,
  );
  console.log(`自检: 单场 Σdelta 绝对值最大 = ${stats.maxAbsDeltaSumPerGame.toExponential(3)}（零和，应≈0）`);
  if (stats.unknownUids.size > 0) {
    const list = [...stats.unknownUids.entries()].map(([uid, n]) => `${uid}(${n}场)`).join(', ');
    console.log(`注意: ${stats.unknownUids.size} 个 uid 在 users.bin 中不存在，其 update 已丢弃: ${list}`);
  }
  console.log('');
  console.log('最大 |delta| 前 20 名:');
  const top = affected.slice(0, 20);
  if (top.length === 0) {
    console.log('  （无变化）');
  }
  for (const row of top) {
    console.log(
      `  ${row.username}: rating ${row.oldRating} -> ${row.newRating} (${row.delta >= 0 ? '+' : ''}${row.delta}), ` +
        `games ${row.oldGames} -> ${row.newGames}, history=${row.historyLength}`,
    );
  }

  if (!applyMode) {
    console.log('');
    console.log('dry-run 结束，未写入任何文件。加 --apply 才会备份并写回 users.bin。');
    return;
  }

  // ---- --apply：强制带时间戳备份，再以与 auth-store.persist 逐字节一致的格式写回 ----
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  const backupPath = `${USERS_BIN}.recalc-backup-${stamp}`;
  await copyFile(USERS_BIN, backupPath);
  console.log(`已备份: ${backupPath}`);

  const binary = await encodeUserFileBinary({ users });
  const tmpPath = `${USERS_BIN}.${process.pid}.tmp`;
  await writeFile(tmpPath, binary);
  await rename(tmpPath, USERS_BIN);
  console.log(`已写回: ${USERS_BIN}（v8 serialize + brotli quality 6，tmp+rename 原子替换）`);
};

main().catch((error) => {
  console.error('重算失败:', error);
  process.exitCode = 1;
});
