'use strict';
const fs=require('node:fs');
const {runMatch}=require('./arena.cjs');
const {chooseAction}=require('../bot/policy.cjs');
const previous=require('./previous/policy.cjs').chooseAction;
const modes=['random','maze','archipelago','mediterranean'];
const args=Object.fromEntries(process.argv.slice(2).map(x=>x.replace(/^--/,'').split('=')));
const count=Number(args.seeds||2),size=Number(args.size||0.8),turns=Number(args.turns||3000);
const output=args.output||'training/results/logistics-comparison.json';
function instrument(policy){const metrics={samples:0,rearArmy:0,totalArmy:0,idleTurns:0,transport:0,builds:0};return {metrics,fn(s){const action=policy(s);if(!action)metrics.idleTurns++;if(/运输|汇兵|筹资|集结|logistics-transport/.test(JSON.stringify(action?.reason||'')))metrics.transport++;if(action?.kind==='build')metrics.builds++;
 if(s.turn%20===0){metrics.samples++;const enemy=[];const own=i=>[s.playerId,s.playerId+50,s.playerId+100,s.playerId+150].includes(s.grid[i]);for(let i=0;i<s.grid.length;i++){const c=s.grid[i],o=c>0&&c<200?c%50:0;if(o&&o!==s.playerId&&!(s.teams.get(o)>0&&s.teams.get(o)===s.teams.get(s.playerId)))enemy.push(i);}for(let i=0;i<s.grid.length;i++)if(own(i)){metrics.totalArmy+=s.army[i];if(!s.isolated[i]&&!enemy.some(e=>Math.abs(Math.floor(e/s.m)-Math.floor(i/s.m))+Math.abs(e%s.m-i%s.m)<=3))metrics.rearArmy+=s.army[i];}}
 return action;}};}
const matches=[];const start=Date.now();
for(const mapMode of modes)for(let seed=0;seed<count;seed++)for(let seat=0;seat<2;seat++){
 const a=instrument(chooseAction),b=instrument(previous),players=seat===0?[a,b]:[b,a];
 const result=runMatch({mapMode,seed:`logistics-${args.suite||'v1'}-${seed}`,mapSize:size,maxTurns:turns,policies:players.map(p=>p.fn)});
 const entry={mapMode,seed,seat,winner:result.winner,turns:result.turns,ended:result.ended,elapsedMs:result.elapsedMs,current:a.metrics,previous:b.metrics};matches.push(entry);console.log(JSON.stringify(entry));
}
const summary={games:matches.length,wins:0,losses:0,unresolved:0,byMap:{}};
for(const g of matches){const field=g.winner===null?'unresolved':g.winner===g.seat?'wins':'losses';summary[field]++;const m=summary.byMap[g.mapMode]||={wins:0,losses:0,unresolved:0};m[field]++;}
fs.writeFileSync(output,JSON.stringify({createdAt:new Date().toISOString(),config:{count,size,turns,suite:args.suite||'v1'},summary,wallMs:Date.now()-start,matches},null,2));console.log(JSON.stringify(summary));
