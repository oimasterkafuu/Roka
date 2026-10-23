import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const dataDir = process.argv[2] || path.join(root, 'static/intro/assets');
const trailer = process.argv[3];
const hashes = JSON.parse(
  await readFile(path.join(import.meta.dirname, 'fixtures/intro-replay-hashes.json')),
);
const boardCode = await readFile(path.join(root, 'static/intro/replay-board.js'), 'utf8');
const { ReplayState, isolatedOpacity, createReplayBoard } = await import(
  `data:text/javascript;base64,${Buffer.from(boardCode).toString('base64')}`
);
const replays = JSON.parse(await readFile(path.join(dataDir, 'replays.json')));
const plan = JSON.parse(await readFile(path.join(dataDir, 'plan.json')));
let verified = 0;
for (const [id, data] of Object.entries(replays.sources)) {
  let original;
  if (trailer) {
    const raw = JSON.parse(
      await readFile(
        path.join(trailer, 'v4/assets', id === 'sixteen' ? 'sixteen-match.json' : `${id}.rpl.frames.json`),
      ),
    );
    original = new Map(raw.frames.map((f) => [f.turn, f]));
  }
  const state = new ReplayState(data);
  // Forward playback followed by backward seeks and a widely spaced forward seek.
  const ticks = [
    ...data.ticks,
    ...data.ticks.toReversed().filter((_, i) => i % 29 === 0),
    data.ticks.at(-1),
    data.ticks[0],
  ];
  for (const tick of ticks) {
    const f = original?.get(tick);
    state.seek(tick);
    if (f) {
      assert.deepEqual([...state.grid], f.grid, `${id} grid at ${tick}`);
      assert.deepEqual([...state.army], f.army, `${id} army at ${tick}`);
      assert.deepEqual([...state.isolated], f.isolated, `${id} isolated at ${tick}`);
      assert.deepEqual(
        state.stats,
        f.stats.map((s) => [s.id, s.land, s.army]),
      );
    }
    const digest = createHash('sha256')
      .update(JSON.stringify([[...state.grid], [...state.army], [...state.isolated], state.stats]))
      .digest('hex');
    assert.equal(digest, hashes[id][tick], `${id} source snapshot hash ${tick}`);
    verified++;
  }
  for (const s of data.stats)
    for (const row of s) assert.equal(row.length, 3, 'only anonymous aggregate stats');
  const moves = replays.actions[id] || [];
  assert(
    moves.every((a, i) => i === 0 || moves[i - 1][0] <= a[0]),
    'arrows indexed in chronological order',
  );
}
assert.equal(isolatedOpacity(0, 0.2), 1);
assert.equal(isolatedOpacity(1, 0.199), 1);
assert.equal(isolatedOpacity(1, 0.2), 0.45);
assert.equal(isolatedOpacity(1, 0.4), 1);
assert.equal(isolatedOpacity(2, 0.499), 1);
assert.equal(isolatedOpacity(2, 0.5), 0.45);
assert.equal(isolatedOpacity(2, 1), 1);
// Persistent film-clock phase does not depend on replay ticks or entering a chapter.
assert.equal(isolatedOpacity(1, 56.2), 0.45);
assert.equal(isolatedOpacity(2, 56.5), 0.45);
assert.equal(plan.duration, 124);
assert.deepEqual(plan.comparison.roi, [4, 12, 5, 6]);
const actions = replays.actions[plan.comparison.source];
for (const tick of [632, 634, 636])
  assert(actions.some((a) => a[0] === tick && a[1] === 15 && a[3] === 15 && a[4] === a[2] + 1 && a[5] === 3));
for (const f of plan.frames)
  if (f.source)
    assert(replays.sources[f.source].ticks.includes(f.tick), `timeline tick ${f.source}/${f.tick}`);
assert(!JSON.stringify(replays).includes('uid'));
console.log(
  `Verified ${verified} complete replay states, arbitrary seeking, anonymous stats, chronological arrows, global blink phases, and all timeline frames.`,
);

// Between replay ticks the cached board repaints only cells whose blink changes.
const contexts = [];
globalThis.document = {
  createElement() {
    const context = {
      clears: 0,
      clearRect() {
        this.clears++;
      },
      fillRect() {},
      drawImage() {},
      fillText() {},
    };
    contexts.push(context);
    return {
      width: 0,
      height: 0,
      getContext() {
        return context;
      },
    };
  },
};
const fixture = {
  n: 1,
  m: 3,
  ticks: [0, 1],
  initial: [0, 3, 42, 1, 1, 201, 0, 0, 2, 3, 7, 2],
  diffs: [[0, 3, 43, 1]],
  stats: [[], []],
};
const board = createReplayBoard(fixture);
const context = contexts[0];
board.update(0, 0);
assert.equal(context.clears, 3);
board.update(0, 0.1);
assert.equal(context.clears, 3, 'unchanged replay/phase must reuse cached terrain');
board.update(0, 0.2);
assert.equal(context.clears, 4, 'only the fast-blinking tile changes');
board.update(0, 0.21);
assert.equal(context.clears, 4, 'float32 phase cache must not trigger repeated redraw');
board.update(0, 0.5);
assert.equal(context.clears, 6, 'fast and slow phase transitions repaint two tiles');
board.update(1, 0.51);
assert.equal(context.clears, 7, 'one changed numeric tile repaints once');
board.dispose();
delete globalThis.document;
console.log('Verified unchanged-cell caching, fast/slow blink repaint boundaries, and numeric tile updates.');
