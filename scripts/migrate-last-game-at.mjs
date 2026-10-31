// OFFLINE ONLY: stop the service before --apply. Node >= 18; no build required.
import { readFile, writeFile, copyFile, rename, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import activity from '../src/rating-activity.js';

export async function migrate(dataDir, apply = false, now = Date.now()) {
  const file = path.join(dataDir, 'users.bin');
  const original = await readFile(file);
  const data = deserialize(brotliDecompressSync(original));
  if (
    !data ||
    !Array.isArray(data.users) ||
    data.users.some((u) => !u || typeof u !== 'object' || Array.isArray(u))
  ) {
    throw new Error('Invalid users database');
  }
  const summary = { total: data.users.length, valid: 0, fromHistory: 0, noEvidence: 0, changed: 0 };
  for (const user of data.users) {
    const result = activity.deriveLastGameAt(user, now);
    if (result.source === 'valid') summary.valid++;
    else {
      summary[result.source === 'history' ? 'fromHistory' : 'noEvidence']++;
      summary.changed++;
      user.lastGameAt = result.value;
    }
  }
  summary.allValidAfter = data.users.every((u) => activity.isValidLastGameAt(u.lastGameAt, now));
  const milkcat = data.users.find(
    (u) => typeof u.username === 'string' && u.username.toLowerCase() === 'milkcat',
  );
  summary.Milkcat = milkcat
    ? { lastGameAt: milkcat.lastGameAt, rating: milkcat.rating, ratingGames: milkcat.ratingGames }
    : null;
  summary.mode = apply ? 'apply' : 'dry-run';
  if (apply && summary.changed) {
    const content = brotliCompressSync(serialize(data));
    const id = `${Date.now()}-${randomUUID()}`;
    const backup = `${file}.last-game-at-original-${id}.bak`;
    const temp = `${file}.${id}.tmp`;
    try {
      await copyFile(file, backup, fsConstants.COPYFILE_EXCL);
      summary.backup = backup;
      await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
      await rename(temp, file);
    } finally {
      await unlink(temp).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let dataDir;
    let apply = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--data-dir' && args[i + 1] && !args[i + 1].startsWith('--')) dataDir = args[++i];
      else if (args[i] === '--apply') apply = true;
      else throw new Error('Usage: node scripts/migrate-last-game-at.mjs --data-dir <path> [--apply]');
    }
    if (!dataDir) throw new Error('--data-dir is required; stop the service before --apply');
    console.log(JSON.stringify(await migrate(dataDir, apply), null, 2));
  } catch {
    console.error(
      'Migration failed. Check arguments, users.bin format and filesystem permissions. Original database is not replaced before successful atomic rename.',
    );
    process.exitCode = 1;
  }
}
