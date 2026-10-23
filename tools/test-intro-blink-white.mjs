// Isolated cells must blink toward white, matching the in-game map on its light
// page background, not toward the transparent black of the dark intro canvas.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const root = path.resolve(import.meta.dirname, '..');
const boardCode = await readFile(path.join(root, 'static/intro/replay-board.js'), 'utf8');
const { createReplayBoard, CELL_W, CELL_H } = await import(
  `data:text/javascript;base64,${Buffer.from(boardCode).toString('base64')}`
);

const created = [];
globalThis.document = {
  createElement() {
    const canvas = createCanvas(1, 1);
    created.push(canvas);
    return canvas;
  },
};

const fixture = {
  n: 1,
  m: 2,
  ticks: [0],
  initial: [0, 3, 42, 1, 1, 201, 0, 0],
  diffs: [],
  stats: [[]],
};
const board = createReplayBoard(fixture);
const surfaceCtx = created[0].getContext('2d');
const px = (ctx, x, y) => [...ctx.getImageData(x, y, 1, 1).data];

board.update(0, 0.2);
let pixel = px(surfaceCtx, 3, 3);
assert.deepEqual(pixel, [141, 141, 255, 255], 'dim phase blends 45% blue over opaque white');
assert.deepEqual(px(surfaceCtx, 0, 0), [141, 141, 141, 255], 'dim phase blends the border over white');

board.update(0, 0);
assert.deepEqual(px(surfaceCtx, 3, 3), [0, 0, 255, 255], 'bright phase keeps full-opacity palette');
assert.deepEqual(px(surfaceCtx, 0, 0), [0, 0, 0, 255], 'bright phase keeps the black border');

board.update(0, 0.2);
const scale = 3;
const target = createCanvas(2 * CELL_W * scale, CELL_H * scale);
board.draw(target.getContext('2d'), [0, 0, 2, 1], [0, 0, 2 * CELL_W * scale, CELL_H * scale], 'cover');
pixel = px(target.getContext('2d'), 3 * scale, 3 * scale);
assert.deepEqual(pixel, [141, 141, 255, 255], 'cover path blends 45% blue over opaque white');

console.log('intro replay blink: isolated cells fade toward opaque white on both paint paths');
