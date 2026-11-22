import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTickGrowth } from '../dist/game-engine/tick-growth.js';
import { LEFT_GAME } from '../dist/game-engine/constants.js';

for (const multiLine of [false, true]) {
  test(`${multiLine ? 'multiline' : 'single-line'} production at burst boundaries`, () => {
    for (const [turn, singlePlain, multiPlain, city] of [
      [25, 0, 0, 0],
      [26, 1, 0, 0],
      [49, 1, 0, 0],
      [50, 2, 1, 1],
      [51, 0, 0, 0],
    ]) {
      const tiles = [
        { type: 0, growth: multiLine ? multiPlain : singlePlain },
        { type: -2, growth: 1 },
        { type: -1, growth: city },
        { type: 2, growth: 0 },
        { type: 0, isolated: true, growth: 0 },
        { type: -1, isolated: true, growth: 0 },
        { type: 0, owner: 0, growth: 0 },
        { type: -2, owner: 0, growth: 0 },
        { type: 0, owner: 2, growth: 0 },
        { type: -2, owner: 2, growth: 0 },
      ];
      const armyCnt = [tiles.map(() => 5)];
      applyTickGrowth({
        multiLine,
        turn,
        n: 1,
        m: tiles.length,
        gridType: [tiles.map((tile) => tile.type)],
        owner: [tiles.map((tile) => tile.owner ?? 1)],
        isolated: [tiles.map((tile) => tile.isolated ?? false)],
        pstat: [0, LEFT_GAME],
        leftGameValue: LEFT_GAME,
        armyCnt,
      });
      assert.deepEqual(
        armyCnt[0],
        tiles.map((tile) => 5 + tile.growth),
        `tick ${turn}`,
      );
    }
  });
}
