/** Reproduce only the public replay ticks used by the 120-second introduction.
 * Usage: node scripts/intro/build-intro-data.mjs [trailer-dir] [output-dir]
 * No user IDs, player names, or private metadata enter the browser bundle.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { trimStandaloneCharge } from './trim-intro-plan.mjs';
const source = process.argv[2] || '/workspace/roka-trailer';
const out = process.argv[3] || 'static/intro/assets';
const read = async (p) => JSON.parse(await readFile(p, 'utf8'));
const plan = trimStandaloneCharge(await read(path.join(source, 'v5/assets/plan.json')));
const compare = plan.shots.find((s) => s.name === 'charge_compare');
Object.assign(compare, { source: 'Y5bAFF7R2i8s', tickStart: 628, tickEnd: 638, roi: [4, 12, 5, 6] });
plan.comparison = {
  source: compare.source,
  ticks: [628, 638],
  roi: compare.roi,
  note: 'Public replay: blue army advances east on row 15 at ticks 632, 634, 636; the last move captures a red tile. Fixed crop, original numeric cells.',
};
for (const f of plan.frames) {
  const s = plan.shots[f.shot];
  if (s.name === 'charge_compare') {
    f.source = s.source;
    f.tick = Math.min(
      s.tickEnd,
      Math.floor(s.tickStart + ((s.tickEnd - s.tickStart) * (f.t - s.start)) / (s.end - s.start)),
    );
  }
}
// The ascend/native crossfade needs the same initial native frame.
const needed = new Map([['Y5bAFF7R2i8s', new Set([126])]]);
for (const f of plan.frames)
  if (f.source && f.tick !== undefined) {
    if (!needed.has(f.source)) needed.set(f.source, new Set());
    needed.get(f.source).add(f.tick);
  }
const sourceHashes = {};
const result = { version: 1, cellWidth: 42, cellHeight: 40, sources: {}, actions: {} };
for (const [id, set] of needed) {
  const raw = await read(
    path.join(source, 'v4/assets', id === 'sixteen' ? 'sixteen-match.json' : `${id}.rpl.frames.json`),
  );
  const index = new Map(raw.frames.map((f) => [f.turn, f]));
  // ROI selection exactly matches the original composition's sixteen_roi().
  if (id === 'sixteen') {
    const f = index.get(800);
    let best = -Infinity;
    for (let i = 0; i < Math.max(1, raw.n - 22); i += 2)
      for (let j = 0; j < Math.max(1, raw.m - 28); j += 2) {
        const owners = [];
        for (let r = i; r < Math.min(raw.n, i + 22); r++)
          for (let c = j; c < Math.min(raw.m, j + 28); c++) {
            const v = f.grid[r * raw.m + c];
            if (v < 200) owners.push(v % 50);
          }
        const score = new Set(owners.filter(Boolean)).size * 50 + owners.length * 0.08;
        if (score > best) {
          best = score;
          plan.sixteenROI = [j, i, Math.min(28, raw.m), Math.min(22, raw.n)];
        }
      }
  }
  const ticks = [...set].sort((a, b) => a - b);
  let previous;
  sourceHashes[id] = {};
  const compact = { n: raw.n, m: raw.m, ticks, initial: null, diffs: [], stats: [] };
  for (const tick of ticks) {
    const f = index.get(tick);
    if (!f) throw new Error(`Missing ${id} tick ${tick}`);
    sourceHashes[id][tick] = createHash('sha256')
      .update(JSON.stringify([f.grid, f.army, f.isolated, f.stats.map((s) => [s.id, s.land, s.army])]))
      .digest('hex');
    const flat = [];
    for (let k = 0; k < f.grid.length; k++) {
      if (
        !previous ||
        f.grid[k] !== previous.grid[k] ||
        f.army[k] !== previous.army[k] ||
        f.isolated[k] !== previous.isolated[k]
      )
        flat.push(k, f.grid[k], f.army[k], f.isolated[k]);
    }
    if (!previous) compact.initial = flat;
    else compact.diffs.push(flat);
    compact.stats.push(f.stats.map((s) => [s.id, s.land, s.army]));
    previous = f;
  }
  result.sources[id] = compact;
  if (id !== 'sixteen') {
    const a = await read(path.join(source, 'v4/assets', `${id}.actions.json`));
    result.actions[id] = a.moves
      .filter((m) => m.turn >= ticks[0] - 2 && m.turn <= ticks.at(-1))
      .sort((a, b) => a.turn - b.turn)
      .map((m) => [m.turn, ...m.from, ...m.to, m.player]);
  }
}
delete plan.needed;
delete plan.onsets;
await mkdir(out, { recursive: true });
for (const [name, data] of [
  ['plan.json', plan],
  ['replays.json', result],
]) {
  const json = JSON.stringify(data);
  await writeFile(path.join(out, name), json);
  console.log(
    `${name}: ${Buffer.byteLength(json)} bytes; gzip ${gzipSync(json).length}; brotli ${brotliCompressSync(json).length}`,
  );
}

const fixtureDir = path.join(import.meta.dirname, 'fixtures');
await mkdir(fixtureDir, { recursive: true });
await writeFile(path.join(fixtureDir, 'intro-replay-hashes.json'), JSON.stringify(sourceHashes) + '\n');
