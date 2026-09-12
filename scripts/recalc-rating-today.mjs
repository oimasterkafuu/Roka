#!/usr/bin/env node
/**
 * 重算「今天以来」的 Rating。
 *
 * 背景：组队结算的队伍分由「队内平均」改为「成员战力总和换算」
 * （400 * log10(Σ 10^(r/400))）。本脚本按回放索引重放全部对局：
 * 今天 00:00（本地时区）之前的对局沿用旧公式复现历史，今天起的对局用新公式重算。
 *
 * 用法（需在仓库根目录，且服务已停止，避免运行中的进程覆盖 users.bin）：
 *   node scripts/recalc-rating-today.mjs --check   校验并预览，不写盘
 *   node scripts/recalc-rating-today.mjs --apply   校验通过后写入 data/users.bin
 *
 * --check 会先用旧公式全量复现并与 users.bin 当前值逐用户比对；
 * 有任何不一致（回放缺失、逻辑不等价）都会拒绝 --apply。
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress, constants as zlibConstants } from 'node:zlib';

const brotliCompressAsync = promisify(brotliCompress);
const brotliDecompressAsync = promisify(brotliDecompress);

const DATA_DIR = path.resolve('data');
const REPLAY_DIR = path.join(DATA_DIR, 'replays');
const USERS_FILE = path.join(DATA_DIR, 'users.bin');

const DEFAULT_RATING = 1200;
const RATING_K = 24;
const RATING_HISTORY_MAX = 1000;

const normalize = (username) => username.trim().toLowerCase();

const toDisplayRating = (rating, ratingGames) => {
  if (!Number.isFinite(rating) || !Number.isFinite(ratingGames) || ratingGames <= 0) {
    return 0;
  }
  const shift = DEFAULT_RATING / 2 ** ratingGames;
  return Math.max(0, Math.round(rating - shift));
};

const todayStartSec = () => {
  const now = new Date();
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
};

const loadIndex = async () => deserialize(await readFile(path.join(REPLAY_DIR, 'index.bin')));

const loadReplayMeta = async (id) => {
  const content = await readFile(path.join(REPLAY_DIR, `${id}.rpl`));
  const raw = await brotliDecompressAsync(content);
  const replay = deserialize(raw);
  return replay.meta;
};

/** 由回放 meta + 索引名次重建 GameResultEntry[]（与 buildGameResult 等价）。 */
const buildResult = (meta, rankList) => {
  const rankByUid = new Map(rankList.map((uid, index) => [uid, index + 1]));
  const result = [];
  for (let i = 0; i < meta.player_names.length; i += 1) {
    const team = meta.player_teams[i];
    if (team === 0) {
      continue;
    }
    const uid = meta.player_names[i];
    result.push({ uid, team, rank: rankByUid.get(uid) ?? 0 });
  }
  // buildGameResult 的兜底是 leaderboard 长度（= 参赛人数）。
  for (const entry of result) {
    if (entry.rank === 0) {
      entry.rank = result.length;
    }
  }
  return result;
};

/**
 * 复现 applyGameResult。useNewFormula=true 时队伍分按战力总和换算，否则取平均。
 * 返回 [{ uid, delta }]，按 result 顺序（与 applyRatingUpdates 的逐个应用一致）。
 */
const computeUpdates = (result, getRating, useNewFormula) => {
  if (result.length < 2) {
    return [];
  }
  const teamRank = new Map();
  for (const entry of result) {
    const prev = teamRank.get(entry.team);
    if (prev === undefined || entry.rank < prev) {
      teamRank.set(entry.team, entry.rank);
    }
  }
  const teams = [...teamRank.keys()];
  if (teams.length < 2) {
    return [];
  }

  const teamRating = new Map();
  for (const team of teams) {
    const members = result.filter((entry) => entry.team === team);
    if (useNewFormula) {
      const strength = members.reduce((sum, entry) => sum + 10 ** (getRating(entry.uid) / 400), 0);
      teamRating.set(team, 400 * Math.log10(strength));
    } else {
      const avg = members.reduce((sum, entry) => sum + getRating(entry.uid), 0) / members.length;
      teamRating.set(team, avg);
    }
  }

  const updates = [];
  for (const team of teams) {
    const rank = teamRank.get(team) ?? teams.length;
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
    for (const entry of result) {
      if (entry.team === team) {
        updates.push({ uid: entry.uid, delta });
      }
    }
  }
  return updates;
};

/** 全量重放，返回 Map<normalize(uid), { rating, games, history }>。 */
const simulate = async (items, newFormulaFromSec) => {
  const states = new Map();
  const getState = (uid) => {
    const key = normalize(uid);
    let state = states.get(key);
    if (!state) {
      state = { rating: DEFAULT_RATING, games: 0, history: [] };
      states.set(key, state);
    }
    return state;
  };

  for (const item of items) {
    const meta = await loadReplayMeta(item.id);
    const result = buildResult(meta, item.rank);
    const useNewFormula = item.time >= newFormulaFromSec;
    const updates = computeUpdates(result, (uid) => getState(uid).rating, useNewFormula);
    for (const update of updates) {
      if (!Number.isFinite(update.delta)) {
        continue;
      }
      const state = getState(update.uid);
      state.rating = Math.round((state.rating + update.delta) * 10) / 10;
      state.games += 1;
      state.history.push({ t: item.time * 1000, r: toDisplayRating(state.rating, state.games) });
      if (state.history.length > RATING_HISTORY_MAX) {
        state.history = state.history.slice(-RATING_HISTORY_MAX);
      }
    }
  }
  return states;
};

const loadUsers = async () => {
  const raw = await brotliDecompressAsync(await readFile(USERS_FILE));
  return deserialize(raw);
};

const main = async () => {
  const apply = process.argv.includes('--apply');
  const cutoff = todayStartSec();
  console.log(`新公式生效起点（本地今天 00:00）: ${new Date(cutoff * 1000).toISOString()} (${cutoff})`);

  const items = (await loadIndex()).sort((a, b) => a.time - b.time);
  console.log(`回放索引共 ${items.length} 场，其中今天以来 ${items.filter((i) => i.time >= cutoff).length} 场。`);

  // 校验：旧公式全量复现，必须与 users.bin 当前值一致。
  const oldStates = await simulate(items, Number.POSITIVE_INFINITY);
  const userFile = await loadUsers();
  let mismatches = 0;
  for (const user of userFile.users) {
    const sim = oldStates.get(normalize(user.username));
    const storedRating = user.rating ?? DEFAULT_RATING;
    const storedGames = user.ratingGames ?? 0;
    const simRating = sim?.rating ?? DEFAULT_RATING;
    const simGames = sim?.games ?? 0;
    if (storedRating !== simRating || storedGames !== simGames) {
      mismatches += 1;
      console.log(
        `[不一致] ${user.username}: 存储 ${storedRating}/${storedGames} 场，复现 ${simRating}/${simGames} 场`,
      );
    }
  }
  for (const [key] of oldStates) {
    if (!userFile.users.some((u) => normalize(u.username) === key)) {
      mismatches += 1;
      console.log(`[不一致] 回放中的用户 ${key} 在 users.bin 中不存在`);
    }
  }
  if (mismatches > 0) {
    console.log(`共 ${mismatches} 处不一致：回放索引无法完整复现历史，禁止重算。`);
    process.exitCode = 1;
    return;
  }
  console.log('旧公式全量复现与 users.bin 完全一致，历史回放完整。');

  // 重算：今天起用新公式。
  const newStates = await simulate(items, cutoff);
  const changes = [];
  for (const user of userFile.users) {
    const sim = newStates.get(normalize(user.username));
    if (!sim) {
      continue;
    }
    const storedRating = user.rating ?? DEFAULT_RATING;
    const storedGames = user.ratingGames ?? 0;
    if (storedRating !== sim.rating || storedGames !== sim.games) {
      changes.push({ user, sim, storedRating, storedGames });
    }
  }

  if (changes.length === 0) {
    console.log('今天以来的对局不涉及队伍人数差异，所有用户 rating 不变。');
    return;
  }
  console.log(`\n重算影响 ${changes.length} 个用户：`);
  for (const { user, sim, storedRating } of changes) {
    console.log(`  ${user.username}: ${storedRating} -> ${sim.rating}（对局数 ${sim.games}）`);
  }

  if (!apply) {
    console.log('\n以上为预览（--check）。确认无误后停服执行 --apply 写盘。');
    return;
  }

  for (const { user, sim } of changes) {
    user.rating = sim.rating;
    user.ratingGames = sim.games;
    user.ratingHistory = sim.history;
    user.updatedAt = Date.now();
  }
  const binary = await brotliCompressAsync(serialize(userFile), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
  });
  const tmpPath = `${USERS_FILE}.${process.pid}.tmp`;
  await writeFile(tmpPath, binary);
  await rename(tmpPath, USERS_FILE);
  console.log(`\n已写入 ${USERS_FILE}。`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
