'use strict';
const {performance}=require('node:perf_hooks');
const path=require('node:path');
const {chooseDefense}=require(path.resolve(process.argv[2]||'bot/defense.cjs'));
function fixture(){const n=24,m=24,s={n,m,playerId:1,turn:500,grid:[],army:[],isolated:Array(n*m).fill(0),teams:new Map([[1,1],[2,2]])};
for(let x=0;x<n;x++)for(let y=0;y<m;y++){s.grid.push(y<12?(x%4===0&&y%4===0?101:1):(x%4===0&&y%4===0?102:2));s.army.push(y<12?20:30);}return s;}
const samples=[];for(let j=0;j<12;j++){const s=fixture();const start=performance.now();chooseDefense(s);if(j>=2)samples.push(performance.now()-start);}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({scenario:'24x24,18 own crowns,288 visible enemy cells,static turn500',runs:samples.length,medianMs:samples[5],maxMs:samples.at(-1)},null,2));
