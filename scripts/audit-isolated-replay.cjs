const fs = require('fs'),
  z = require('zlib'),
  v8 = require('v8');
const { GameEngine } = require('../dist/game-engine.js');
const replay = v8.deserialize(z.brotliDecompressSync(fs.readFileSync(process.argv[2])));
console.log(JSON.stringify({ meta: replay.meta, total_turns: replay.total_turns }));
let events = [],
  deaths = [];
const attack = GameEngine.prototype.attack,
  conn = GameEngine.prototype.applyConnectivity;
GameEngine.prototype.attack = function (x, y, dx, dy, mode) {
  const a = this.owner[x][y],
    d = this.owner[dx][dy],
    before = this.armyCnt[dx][dy],
    iso = this.isolated[dx][dy],
    push = this.computePush(x, y, dx, dy, mode);
  const result = attack.call(this, x, y, dx, dy, mode);
  if (result && iso && d > 0 && this.team[d - 1] === this.team[a - 1] && push > 0)
    events.push({
      tick: this.turn,
      attacker: this.names[a - 1],
      defender: this.names[d - 1],
      pstat: this.pstat[d - 1],
      target: [dx, dy],
      before,
      push,
      after: this.armyCnt[dx][dy],
    });
  return result;
};
GameEngine.prototype.applyConnectivity = function () {
  conn.call(this);
  for (const ev of events.filter((e) => e.tick === this.turn)) {
    ev.connected = !this.isolated[ev.target[0]][ev.target[1]];
    ev.final = this.armyCnt[ev.target[0]][ev.target[1]];
  }
  const ssr = this.names.indexOf('ssr');
  if (ssr >= 0 && this.pstat[ssr] === 52 && !deaths.length)
    deaths.push({ tick: this.turn, pstat: this.pstat[ssr], deadOrder: this.deadOrder[ssr] });
};
(async () => {
  for (const fix of [false, true]) {
    events = [];
    deaths = [];
    const r = structuredClone(replay);
    if (fix) r.meta.isolated_reinforcement_fix = true;
    const built = await GameEngine.buildReplayFromActions(r);
    console.log(JSON.stringify({ fix, ssr: deaths, events, patches: built.patches.length }));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
