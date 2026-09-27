'use strict';
const { parentPort } = require('node:worker_threads');
const { runMatch } = require('./arena.cjs');
const { chooseAction } = require('../bot/policy.cjs');
const { chooseMove } = require('./baseline/planner.cjs');
const { chooseBuild } = require('./baseline/building.cjs');
function policy(params) {
  if (params === 'baseline') return s => { const move=chooseMove(s), build=chooseBuild(s,move); return build ? {kind:'build',...build} : move ? {kind:'attack',...move} : null; };
  return s => chooseAction(s,params);
}
parentPort.on('message', job => {
  try { const {players,...options}=job.options; parentPort.postMessage({id:job.id,result:runMatch({...options,policies:players.map(policy)})}); }
  catch(error) {parentPort.postMessage({id:job.id,error:error.stack});}
});
