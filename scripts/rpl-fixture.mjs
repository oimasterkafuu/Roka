import { GameEngine } from '../dist/game-engine.js';

export async function recordFixture(meta, ticks, beforeTick = () => {}) {
  let actions;
  const ids = meta.player_names;
  const engine = await GameEngine.create(meta, ids, ids, 'fixture', {
    chatMessage() {},
    update() {},
    emitInitMap() {},
    endGame() {},
    md5: String,
    replayStore: {
      async saveReplay(raw) {
        actions = structuredClone(raw);
        return 'fixture';
      },
    },
  });
  for (let tick = 1; tick <= ticks; tick++) {
    beforeTick(engine, tick);
    await engine.gameTick();
  }
  await engine.saveHistory();
  return actions;
}
