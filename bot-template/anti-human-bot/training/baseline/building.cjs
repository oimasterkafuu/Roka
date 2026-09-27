'use strict';
// 只在安全后方投资；50兵建指挥所，再花50升级主城。
function chooseBuild(state, move) {
  if (!state || state.playerId < 1 || state.ended || state.dead) return null;
  if (move && /防守|守主城|斩首|清除威胁|回收孤军|打通孤军/.test(move.reason)) return null;
  const { n, m, grid, army, playerId: me, teams } = state;
  const own = code => code === me || code === me+50 || code === me+100 || code === me+150;
  const owner = code => code > 0 && code < 200 ? code % 50 : 0;
  const team = teams?.get(me);
  const allied = id => id === me || (id > 0 && team > 0 && teams?.get(id) === team);
  const land = grid.filter(own).length;
  const crowns = grid.filter(code => code === me+100).length;
  // 每20块领土允许一座额外主城，最多4座，避免投资淹没军事行动。
  if (crowns >= Math.min(4, 1 + Math.floor(land / 20))) return null;
  let best = null;
  for (let i=0;i<grid.length;i++) {
    const upgrade = grid[i] === me+50;
    if ((!upgrade && grid[i] !== me) || state.isolated?.[i] || state.fog?.[i]) continue;
    const reserve = 12;
    if (army[i] < (upgrade ? 50 : 100) + reserve) continue;
    const x=Math.floor(i/m), y=i%m;
    let safe=true, friendly=0;
    for (let dx=-3;dx<=3 && safe;dx++) for (let dy=-3;dy<=3;dy++) {
      const d=Math.abs(dx)+Math.abs(dy), nx=x+dx, ny=y+dy;
      if (!d || d>3 || nx<0 || nx>=n || ny<0 || ny>=m) continue;
      const j=nx*m+ny;
      if (state.fog?.[j] || grid[j]===202 || grid[j]===203 || (owner(grid[j]) && !allied(owner(grid[j])))) { safe=false; break; }
      if (d===1 && own(grid[j]) && !state.isolated?.[j]) friendly++;
    }
    if (!safe || friendly < 2) continue;
    const score=(upgrade ? 10000 : 0)+friendly*100+army[i];
    if (!best || score>best.score) best={x,y,op:upgrade?'c':'b',reason:upgrade?'安全后方升级主城':'安全后方建造指挥所',score};
  }
  if (!best) return null;
  const { score, ...action }=best;
  return action;
}
module.exports={chooseBuild};
