// 自动主城转属单元冒烟：覆盖有效推兵、最后一座保护、三种推兵模式、
// 来源保留、零推出、敌方/己方/指挥所规则，以及旧回放显式转让兼容入口。
// 运行前需先 `pnpm run build`（本脚本读取 dist 产物）。

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(rootDir, 'package.json'));
const { GameEngine } = require('./dist/game-engine.js');

let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  ok - ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL - ${label}`);
  }
};

async function createEngine() {
  return GameEngine.create(
    {
      speed: 1,
      width_ratio: 0.5,
      height_ratio: 0.5,
      swamp_ratio: 0.1,
      map_token: 'auto-crown-test',
      map_mode: 'random',
      map_region: 'china',
      allow_team: true,
      fog: false,
      map_size: 'normal',
      player_names: ['alice', 'bob', 'carol'],
      player_teams: [1, 1, 2],
    },
    ['sidAlice', 'sidBob', 'sidCarol'],
    ['idAlice', 'idBob', 'idCarol'],
    'auto-crown-test',
    {
      update: () => undefined,
      emitInitMap: () => undefined,
      chatMessage: () => undefined,
      endGame: () => undefined,
      md5: (input) => input,
      replayStore: { saveReplay: async () => '' },
    },
  );
}

function clearBoard(engine) {
  for (let i = 0; i < engine.n; i += 1) {
    for (let j = 0; j < engine.m; j += 1) {
      engine.gridType[i][j] = 0;
      engine.owner[i][j] = 0;
      engine.armyCnt[i][j] = 0;
      engine.isolated[i][j] = false;
      engine.isolatedAge[i][j] = 0;
    }
  }
}

function setup(engine, { sourceArmy = 10, targetArmy = 0, targetType = -2, targetOwner = 2, extraBobCrown = false } = {}) {
  clearBoard(engine);
  const sx = 2;
  const sy = 2;
  const tx = 2;
  const ty = 3;
  engine.owner[sx][sy] = 1;
  engine.armyCnt[sx][sy] = sourceArmy;
  engine.owner[tx][ty] = targetOwner;
  engine.gridType[tx][ty] = targetType;
  engine.armyCnt[tx][ty] = targetArmy;
  if (extraBobCrown) {
    engine.owner[1][3] = 2;
    engine.gridType[1][3] = -2;
    engine.armyCnt[1][3] = 7;
  }
  return { sx, sy, tx, ty };
}

function attack(engine, source, target, mode) {
  return engine.attack(source.sx, source.sy, target.tx, target.ty, mode);
}

async function main() {
  const engine = await createEngine();

  let pos = setup(engine, { extraBobCrown: true });
  check('有效全兵推入队友多主城自动转属', attack(engine, pos, pos, 2) && engine.owner[pos.tx][pos.ty] === 1);
  check('自动转属保持主城类型并叠加兵力', engine.gridType[pos.tx][pos.ty] === -2 && engine.armyCnt[pos.tx][pos.ty] === 9);
  check('来源保留 1 兵', engine.armyCnt[pos.sx][pos.sy] === 1);

  pos = setup(engine, { extraBobCrown: false });
  check('队友最后一座主城只累兵不转属', attack(engine, pos, pos, 2) && engine.owner[pos.tx][pos.ty] === 2 && engine.armyCnt[pos.tx][pos.ty] === 9);

  for (const [mode, expected] of [[0, 9], [1, 6], [2, 9]]) {
    pos = setup(engine, { extraBobCrown: true });
    const worked = attack(engine, pos, pos, mode);
    check(`推兵模式 ${mode} 推出量为 ${expected}（实际 ${engine.armyCnt[pos.tx][pos.ty]}）`, worked && engine.armyCnt[pos.tx][pos.ty] === expected);
  }

  pos = setup(engine, { sourceArmy: 1, extraBobCrown: true });
  check('cnt=0 不转属且不改变兵力', !attack(engine, pos, pos, 2) && engine.owner[pos.tx][pos.ty] === 2 && engine.armyCnt[pos.tx][pos.ty] === 0);

  pos = setup(engine, { targetType: 0, targetOwner: 2, extraBobCrown: true });
  check('普通同队地块仍转为出兵者', attack(engine, pos, pos, 2) && engine.owner[pos.tx][pos.ty] === 1);

  pos = setup(engine, { targetType: -1, targetOwner: 2, extraBobCrown: true });
  check('指挥所仍转为出兵者', attack(engine, pos, pos, 2) && engine.owner[pos.tx][pos.ty] === 1);

  pos = setup(engine, { targetType: -2, targetOwner: 3, targetArmy: 20, extraBobCrown: true });
  check('敌方主城不触发友军转属', attack(engine, pos, pos, 2) && engine.owner[pos.tx][pos.ty] === 3);

  pos = setup(engine, { extraBobCrown: true });
  engine.applyCrownTransfer(0, pos.tx, pos.ty);
  check('旧回放显式转让兼容入口仍可读取执行', engine.owner[pos.tx][pos.ty] === 1 && engine.gridType[pos.tx][pos.ty] === -2);

  if (failures > 0) {
    console.error(`\n${failures} 项检查失败。`);
    process.exit(1);
  }
  console.log('\n全部检查通过。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
