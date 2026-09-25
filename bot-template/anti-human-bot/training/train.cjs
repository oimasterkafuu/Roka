'use strict';
const {Worker}=require('node:worker_threads');
const os=require('node:os');
const fs=require('node:fs');
const path=require('node:path');
const {DEFAULT_PARAMS,PARAM_RANGES}=require('../bot/params.cjs');
const modes=['random','maze','archipelago','mediterranean'];
const opts=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split('=')));
for(const [key,def,min,max] of [['rounds',4,0,10000],['seeds',2,1,10000],['validation',3,1,10000],['workers',4,1,64],['turns',2200,1,100000],['seed',20260925,0,4294967295]]) {
 const value=Number(opts[key]??def);if(!Number.isInteger(value)||value<min||value>max)throw new Error(`无效参数 --${key}`);
}
if(!Number.isFinite(Number(opts.size??0.5))||Number(opts.size??0.5)<0.2||Number(opts.size??0.5)>1.35)throw new Error('无效参数 --size');
const rounds=Number(opts.rounds??4), seeds=Number(opts.seeds??2), maxTurns=Number(opts.turns??2200);
const workerCount=Math.max(1,Math.min(Number(opts.workers||4),os.availableParallelism?.()||os.cpus().length));
let rng=Number(opts.seed||20260925)>>>0;
function random(){rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng/4294967296;}
class Pool {
  constructor(n){this.queue=[];this.next=0;this.slots=Array.from({length:n},()=>{const slot={worker:new Worker(path.join(__dirname,'worker.cjs')),job:null};slot.worker.on('message',r=>{const j=slot.job;slot.job=null;r.error?j.reject(new Error(r.error)):j.resolve(r.result);this.dispatch();});slot.worker.on('error',e=>{slot.job?.reject(e);slot.job=null;for(const j of this.queue.splice(0))j.reject(e);});return slot;});}
  run(options){return new Promise((resolve,reject)=>{this.queue.push({id:this.next++,options,resolve,reject});this.dispatch();});}
  dispatch(){for(const slot of this.slots)if(!slot.job&&this.queue.length){slot.job=this.queue.shift();slot.worker.postMessage({id:slot.job.id,options:slot.job.options});}}
  async close(){await Promise.all(this.slots.map(s=>s.worker.terminate()));}
}
function mutate(p){const next={...p};const names=Object.keys(PARAM_RANGES);for(let i=0;i<3;i++){const key=names[Math.floor(random()*names.length)], [min,max]=PARAM_RANGES[key];next[key]=Math.max(min,Math.min(max,p[key]+(random()*2-1)*(max-min)*0.22));if(Number.isInteger(min)&&Number.isInteger(max)&&max-min>10)next[key]=Math.round(next[key]);}return next;}
function summary(games){const out={games:games.length,wins:0,losses:0,draws:0,score:0,byMap:{},builds:0,elapsedMs:0};for(const g of games){const score=g.result.winner===null?0.5:g.result.winner===g.seat?1:0;out.wins+=score===1;out.losses+=score===0;out.draws+=score===0.5;out.score+=score;out.elapsedMs+=g.result.elapsedMs||0;out.builds+=(g.result.builds||[]).filter(b=>b.player===g.seat).length;const m=out.byMap[g.mapMode]||={games:0,wins:0,losses:0,draws:0,score:0};m.games++;m.wins+=score===1;m.losses+=score===0;m.draws+=score===0.5;m.score+=score;}out.score/=out.games;for(const m of Object.values(out.byMap))m.score/=m.games;return out;}
(async()=>{
 const started=Date.now(),pool=new Pool(workerCount),history=[];
 let champion={...DEFAULT_PARAMS};
 if(opts.resume)champion={...champion,...JSON.parse(fs.readFileSync(opts.resume,'utf8')).params};
 const pair=async(candidate,opponent,phase,round,count)=>{
  const jobs=[];for(const mapMode of modes)for(let s=0;s<count;s++)for(let seat=0;seat<2;seat++){
   const seed=`${phase}-${opts.suite||'v1'}-${round}-${s}`;const players=seat===0?[candidate,opponent]:[opponent,candidate];
   jobs.push(pool.run({mapMode,seed,maxTurns,mapSize:Number(opts.size||0.5),players}).then(result=>({mapMode,seed,seat,result})));
  }return Promise.all(jobs);
 };
 try{
  for(let round=0;round<rounds;round++){
   const candidate=mutate(champion),games=await pair(candidate,champion,'train',round,seeds),stats=summary(games);
   let accepted=stats.score>0.5, gate=null;
   if(accepted){
    const gateGames=await pair(candidate,'baseline','gate',round,seeds), championGate=await pair(champion,'baseline','gate',round,seeds);
    const proposed=summary(gateGames),current=summary(championGate); gate={proposed,current};
    accepted=proposed.score>=current.score && modes.every(mode=>proposed.byMap[mode].score>=current.byMap[mode].score-0.125);
   }
   history.push({round,params:candidate,accepted,stats,gate});if(accepted)champion=candidate;
   console.log(JSON.stringify({stage:'train',round,accepted,...stats}));
  }
  const validation=await pair(champion,'baseline','heldout',99,Number(opts.validation||3));
  const defaultsValidation=await pair(DEFAULT_PARAMS,'baseline','heldout',99,Number(opts.validation||3));
  const stats=summary(validation),defaultStats=summary(defaultsValidation);
  // 验证集仅用于报告，不据此回灌搜索；最终报告包括所有地图与平局。
  const hash=file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const sources=Object.fromEntries(['bot/planner.cjs','bot/building.cjs','bot/params.cjs','training/arena.cjs','training/baseline/planner.cjs','training/baseline/building.cjs','reference/src/game-engine.ts'].map(file=>[file,hash(file)]));
  const report={createdAt:new Date().toISOString(),suite:opts.suite||'v1',resume:opts.resume||null,sources,seed:opts.seed||20260925,config:{rounds,seeds,maxTurns,workerCount,mapSize:Number(opts.size||0.5)},params:champion,history,validation:stats,defaultsValidation:defaultStats,matches:validation,wallMs:Date.now()-started};
  fs.mkdirSync(path.join(__dirname,'results'),{recursive:true});const output=opts.output||'training/results/latest.json';fs.writeFileSync(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify({stage:'heldout',...stats,defaults:defaultStats,wallMs:report.wallMs,output}));
 }finally{await pool.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
