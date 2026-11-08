'use strict';

const { evaluate, runCli } = require('./long-eval.cjs');

async function runSuite(maxTurns = 600) {
  return evaluate({ seeds: 1, turns: maxTurns, seedPrefix: 'apex-benchmark' });
}
if (require.main === module) {
  runCli(process.argv.slice(2), {
    seeds: process.env.APEX_EVAL_SEEDS ?? 1,
    turns: process.env.APEX_BENCH_TURNS ?? process.env.APEX_EVAL_TURNS ?? 600,
    seedPrefix: process.env.APEX_EVAL_PREFIX ?? 'apex-benchmark',
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.stack || error);
      process.exitCode = 1;
    });
}
module.exports = { runSuite };
