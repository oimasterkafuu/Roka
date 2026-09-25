'use strict';
const {runMatch}=require('./arena.cjs');
const {chooseAction}=require('../bot/policy.cjs');
const {performance}=require('node:perf_hooks');
// 相同地图和策略，预热后报告实际决策吞吐，不以空策略引擎速度冒充训练速度。
runMatch({mapMode:'random',seed:'warmup',maxTurns:100,policies:[chooseAction,chooseAction]});
const start=performance.now();let turns=0,builds=0;
for(const mapMode of ['random','maze','archipelago','mediterranean'])for(let seed=0;seed<2;seed++){
 const r=runMatch({mapMode,seed:`bench-${seed}`,maxTurns:1200,policies:[chooseAction,chooseAction]});turns+=r.turns;builds+=r.builds.length;
}
const ms=performance.now()-start;console.log(JSON.stringify({games:8,turns,builds,wallMs:ms,ticksPerSecond:turns/ms*1000,speedupVs4x:turns/ms*1000/8},null,2));
