// 一次性迁移：把 users.bin 中 ratingHistory 的内部实际分换算为新手显示分。
// 第 i 个历史点（从旧到新）对应对局数 = ratingGames - 历史长度 + i + 1。
import { readFile, writeFile } from 'node:fs/promises';
import { serialize, deserialize } from 'node:v8';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress, constants } from 'node:zlib';

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

const DEFAULT_RATING = 1200;
const toDisplayRating = (rating, ratingGames) => {
  if (!Number.isFinite(rating) || !Number.isFinite(ratingGames) || ratingGames <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(rating - DEFAULT_RATING / 2 ** ratingGames));
};

const filePath = new URL('../data/users.bin', import.meta.url);
const raw = await readFile(filePath);
const data = deserialize(await decompress(raw));

let changedPoints = 0;
let changedUsers = 0;
for (const user of data.users) {
  const history = Array.isArray(user.ratingHistory) ? user.ratingHistory : [];
  const total = Number.isFinite(user.ratingGames) ? user.ratingGames : 0;
  let userChanged = false;
  user.ratingHistory = history.map((point, index) => {
    const games = total - history.length + index + 1;
    const r = toDisplayRating(point.r, games);
    if (r !== point.r) {
      changedPoints += 1;
      userChanged = true;
    }
    return { t: point.t, r };
  });
  if (userChanged) {
    changedUsers += 1;
  }
}

const out = await compress(serialize(data), {
  params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
});
await writeFile(filePath, out);
console.log(`migrated ${changedPoints} history points across ${changedUsers} users (total ${data.users.length})`);
