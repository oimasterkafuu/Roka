import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { trimStandaloneCharge } from './trim-intro-plan.mjs';
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
const uncut = {
  duration: 124,
  shots: [
    { name: 'sixteen_close', start: 76, end: 84, nominalStart: 76, nominalEnd: 84 },
    { name: 'charge', start: 84, end: 88, nominalStart: 84, nominalEnd: 88 },
    {
      name: 'charge_compare',
      start: 88,
      end: 92,
      nominalStart: 88,
      nominalEnd: 92,
      source: 'Y5bAFF7R2i8s',
      tickStart: 628,
      tickEnd: 638,
      roi: [4, 12, 5, 6],
    },
    { name: 'crisis', start: 92, end: 100, nominalStart: 92, nominalEnd: 100 },
    { name: 'end', start: 116, end: 124, nominalStart: 116, nominalEnd: 124 },
  ],
  frames: [
    { t: 83.96666666666667, shot: 0, source: 'sixteen', tick: 798 },
    { t: 84, shot: 1 },
    { t: 87.96666666666667, shot: 1 },
    { t: 88, shot: 2, source: 'Y5bAFF7R2i8s', tick: 628 },
    { t: 88.03333333333333, shot: 2, source: 'Y5bAFF7R2i8s', tick: 628 },
    { t: 91.96666666666667, shot: 2, source: 'Y5bAFF7R2i8s', tick: 637 },
    { t: 92, shot: 3, source: 'wh0Et-JN3Gso', tick: 1490 },
    { t: 123.96666666666667, shot: 4 },
  ],
  beats: [83.5, 84, 87.5, 88, 88.5, 92, 123.5].map((time) => ({ time })),
};
const trimmed = trimStandaloneCharge(uncut);
assert.equal(uncut.duration, 124, 'the pure trim does not mutate its source');
assert.equal(trimmed.duration, 120);
assert.deepEqual(
  trimmed.frames.map((frame) => [frame.t, frame.shot]),
  [
    [83.96666666666667, 0],
    [84, 1],
    [84.03333333333333, 1],
    [87.96666666666667, 1],
    [88, 2],
    [119.96666666666667, 3],
  ],
  'old frames before 84 are unchanged and old frames at/after 88 move back four seconds',
);
assert.equal(trimmed.frames[1].source, uncut.frames[3].source);
assert.equal(trimmed.frames[1].tick, uncut.frames[3].tick);
assert.equal(trimmed.frames[4].tick, 1490);
assert.deepEqual(
  trimmed.beats.map((beat) => beat.time),
  [83.5, 84, 84.5, 88, 119.5],
);
assert.equal(trimmed.shots[1].start, 84);
assert.equal(trimmed.shots[1].end, 88);
assert.equal(trimmed.shots[1].tickStart, 628);
assert.equal(trimmed.shots[1].tickEnd, 638);
assert.deepEqual(trimmed.shots[1].roi, [4, 12, 5, 6]);

assert.equal(plan.duration, 120);
assert.equal(plan.shots.length, 18);
assert.equal(plan.frames.length, 3600);
assert(!plan.shots.some((shot) => shot.name === 'charge'), 'standalone charge is removed');
const comparison = plan.shots.find((shot) => shot.name === 'charge_compare');
assert.equal(comparison.start, 84);
assert.equal(comparison.end, 88);
assert.equal(comparison.nominalStart, 84);
assert.equal(comparison.nominalEnd, 88);
assert.equal(comparison.tickStart, 628);
assert.equal(comparison.tickEnd, 638);
assert.deepEqual(comparison.roi, [4, 12, 5, 6]);
const crisis = plan.shots.find((shot) => shot.name === 'crisis');
assert.equal(crisis.start, 88);
assert.equal(crisis.end, 96);
assert.equal(crisis.nominalStart, 88);
assert.equal(crisis.nominalEnd, 96);
assert(Math.abs(plan.frames.at(-1).t - 119.96666666666667) < 1e-9);
for (const [index, frame] of plan.frames.entries()) {
  assert(Math.abs(frame.t - index / plan.fps) < 1e-9, `continuous frame time ${index}`);
  assert(Number.isInteger(frame.shot) && frame.shot >= 0 && frame.shot < plan.shots.length);
  const shot = plan.shots[frame.shot];
  assert(frame.t >= shot.start && frame.t < shot.end, `frame ${index} belongs to ${shot.name}`);
}
const comparisonFrames = plan.frames.filter((frame) => frame.shot === plan.shots.indexOf(comparison));
assert.equal(comparisonFrames[0].t, 84);
assert.equal(comparisonFrames[0].tick, 628);
assert.equal(comparisonFrames.at(-1).tick, 637);
for (const [index, beat] of plan.beats.entries()) {
  assert(beat.time >= 0 && beat.time < 120);
  assert(index === 0 || beat.time > plan.beats[index - 1].time, 'beats stay unique and ordered');
}
assert.deepEqual(plan.comparison.ticks, [628, 638]);
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
