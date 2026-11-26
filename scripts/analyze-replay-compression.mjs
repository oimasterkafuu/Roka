import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { deserialize } from 'node:v8';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { REPLAY_OPS_VERSION } from '../dist/types.js';

const directory = path.resolve(process.env.ROKA_DATA_DIR ?? 'data', 'replays');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : Infinity;
const files = (await readdir(directory))
  .filter((name) => name.endsWith('.rpl'))
  .sort()
  .slice(0, limit);
const totals = {
  files: 0,
  skipped: 0,
  turns: 0,
  archiveBytes: 0,
  serializedBytes: 0,
  brotliQ11Bytes: 0,
  discoveries: 0,
};
const ops = { w: 0, r: 0, q: 0 };
const actions = { m: 0, b: 0, c: 0 };
for (const name of files) {
  try {
    const archive = await readFile(path.join(directory, name));
    const raw = brotliDecompressSync(archive);
    const replay = deserialize(raw);
    if (replay?.version !== REPLAY_OPS_VERSION || !Array.isArray(replay.exploration)) {
      totals.skipped += 1;
      continue;
    }
    totals.files += 1;
    totals.turns += replay.total_turns;
    totals.archiveBytes += archive.length;
    totals.serializedBytes += raw.length;
    totals.brotliQ11Bytes += brotliCompressSync(raw, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length;
    totals.discoveries += replay.exploration.reduce((count, [, entries]) => count + entries.length / 2, 0);
    for (const stream of replay.player_ops) {
      for (const op of stream) {
        ops[op.op] += 1;
        if (op.op === 'q') for (const action of op.actions) actions[action.kind] += 1;
      }
    }
  } catch {
    totals.skipped += 1;
  }
}
console.log(JSON.stringify({ ...totals, ops, actions }, null, 2));
