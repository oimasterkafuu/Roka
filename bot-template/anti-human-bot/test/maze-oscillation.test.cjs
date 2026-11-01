'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
// 可对同一组断言加载修复前的独立源码副本。
const bot = process.env.ANTI_HUMAN_BASELINE || path.resolve(__dirname, '../bot');
const { chooseNeckGuard } = require(path.join(bot, 'cutoff.cjs'));
const { createFrontline } = require(path.join(bot, 'frontline.cjs'));
const { chooseCampaign } = require(path.join(bot, 'campaign.cjs'));
function corridor() {
  const n = 3, m = 9, grid = Array(n * m).fill(201), army = Array(n * m).fill(0);
  for (let y = 0; y < 7; y++) { grid[m + y] = 1; army[m + y] = 1; }
  grid[m] = 101; army[m] = 50;
  grid[m + 7] = 2; army[m + 7] = 60;
  grid[m + 8] = 102; army[m + 8] = 20;
  return { n, m, turn: 501, playerId: 1, grid, army, isolated: Array(n*m).fill(0),
    teams: new Map([[1, 1], [2, 2]]) };
}
test('主力挡住敌堆时，不为后方薄关卡把主力召回', () => {
  const s = corridor(); s.army[s.m + 6] = 300;
  s.grid[s.m + 2] = 101; s.army[s.m + 2] = 50;
  assert.equal(chooseNeckGuard(s), null);
});
test('刚补好的关卡向后方搬兵须留守，向敌方向移动可由主力作屏障', () => {
  const s = corridor(); s.army[s.m + 4] = 300; s.army[s.m + 6] = 40;
  const front = createFrontline(s);
  const away = front.assess({ x: 1, y: 4, dx: 1, dy: 3, mode: 0 });
  assert.ok(away); assert.equal(away.mode, 1);
  const forward = front.assess({ x: 1, y: 4, dx: 1, dy: 5, mode: 0 });
  assert.ok(forward); assert.notEqual(forward.mode, 1);
});
test('迷宫局部可推进时不因不连通的敌方后备军取消攻城目标', () => {
  const s = corridor(); s.army[s.m + 6] = 100;
  s.grid[0] = 2; s.army[0] = 10000;
  const a = chooseCampaign(s, {}, { boundaryAdvance: true, targetOwner: 2 });
  assert.ok(a); assert.equal(a.reason.target, s.m + 8);
  assert.equal(a.reason.phase, 'advance');
  assert.equal(a.y, 6); assert.equal(a.dy, 7);
});
