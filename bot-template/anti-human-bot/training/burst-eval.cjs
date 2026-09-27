'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { MAP_MODES } = require('./arena.cjs');
const { fingerprints } = require('./burst-worker.cjs');

function parseArgs(argv) {
  const args = {};
  const allowed = ['workers', 'seeds', 'turns', 'size', 'suite', 'output', 'self', 'opponent'];
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match || !allowed.includes(match[1])) throw new Error(`未知参数: ${argv[i]}`);
    const key = match[1], value = match[2] === undefined ? argv[++i] : match[2];
    if (key in args || !value || value.startsWith('--')) throw new Error(`重复或缺失参数: --${key}`);
    args[key] = value;
  }
  function integer(key, fallback, min, max) {
    const text = args[key] ?? String(fallback), n = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${key} 必须为 [${min}, ${max}] 整数`);
    return n;
  }
  if (args.opponent && !['preburst','prearchitecture','preresilience','precampaign'].includes(args.opponent)) throw new Error('无效opponent');
  const size = Number(args.size ?? 0.5);
  if (!Number.isFinite(size) || size < 0.2 || size > 1.35) throw new Error('size 必须在 [0.2, 1.35]');
  const suite = args.suite ?? `burst-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(suite)) throw new Error('suite 必须为 1–160 位字母、数字、点、下划线或短横线前缀');
  return { workers: integer('workers', 6, 1, 128), seeds: integer('seeds', 4, 1, 10000),
    turns: integer('turns', 1600, 1, 1000000), size, suite, opponent: args.opponent || 'preburst',
    self: Boolean(integer('self', 0, 0, 1)), output: path.resolve(args.output ?? `training/results/${suite}.json`) };
}

function summarize(matches) {
  const summary = {};
  for (const label of ['current', 'opponent']) {
    const side = { games: matches.length, wins: 0, losses: 0, timeoutUnresolved: 0, endedWithoutWinner: 0,
      byMap: {}, checkpoints: {}, acceptedActions: { attacks: 0, builds: 0, upgrades: 0, rejected: 0 } };
    for (const game of matches) {
      const field = game.outcome === 'timeout_unresolved' ? 'timeoutUnresolved' : game.winnerSide === null ? 'endedWithoutWinner' : game.winnerSide === label ? 'wins' : 'losses';
      side[field]++;
      const map = side.byMap[game.mapMode] ||= { games: 0, wins: 0, losses: 0, timeoutUnresolved: 0, endedWithoutWinner: 0 };
      map.games++; map[field]++;
      for (const key of Object.keys(side.acceptedActions)) side.acceptedActions[key] += game.sides[label].acceptedStats[key];
    }
    for (const tick of [25, 50, 100, 200]) {
      const samples = matches.map(g => g.sides[label].checkpoints[tick]).filter(Boolean);
      side.checkpoints[tick] = { sampledGames: samples.length, missingGames: matches.length - samples.length,
        means: Object.fromEntries(['land', 'ordinaryLand', 'army', 'buildings', 'generalCount', 'generalArmy'].map(key =>
          [key, samples.length ? samples.reduce((sum, s) => sum + s[key], 0) / samples.length : null])) };
    }
    summary[label] = side;
  }
  return summary;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (fs.existsSync(config.output)) throw new Error(`拒绝覆盖已有输出: ${config.output}`);
  const hashes = fingerprints(), start = performance.now(), createdAt = new Date().toISOString();
  const jobs = [];
  for (const mapMode of MAP_MODES) for (let seedIndex = 0; seedIndex < config.seeds; seedIndex++) for (let seat = 0; seat < 2; seat++) {
    jobs.push({ id: jobs.length, mapMode, seedIndex, seed: `${config.suite}-${mapMode}-${seedIndex}`, seat });
  }
  const workers = [], matches = [];
  let next = 0, finished = false;
  // 包括启动在内，每个作业最多 10 分钟无响应；异常立即终止整个池，不输出伪完整报告。
  const watchdogMs = 10 * 60 * 1000;
  let onSignal;
  try {
    await new Promise((resolve, reject) => {
      function fail(error) { if (!finished) { finished = true; reject(error); } }
      onSignal = () => fail(new Error('评估收到中断信号'));
      process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
      for (let i = 0; i < Math.min(config.workers, jobs.length); i++) {
        const worker = new Worker(path.join(__dirname, 'burst-worker.cjs'), { workerData: config });
        const slot = { worker, timer: null, job: null, ready: false }; workers.push(slot);
        function arm() { clearTimeout(slot.timer); slot.timer = setTimeout(() => fail(new Error(`worker ${i} 超过 ${watchdogMs}ms 无响应，job=${slot.job?.id ?? '初始化'}`)), watchdogMs); }
        function dispatch() {
          clearTimeout(slot.timer);
          if (next < jobs.length) { slot.job = jobs[next++]; worker.postMessage(slot.job); arm(); }
          else slot.job = null;
        }
        arm();
        worker.on('error', fail);
        worker.on('exit', code => { if (!finished) fail(new Error(`worker ${i} 意外退出，code=${code}`)); });
        worker.on('message', message => {
          if (finished) return;
          try {
            if (message.type === 'failure') throw new Error(`worker ${i}: ${message.error}`);
            if (message.type === 'ready' && !slot.ready) {
              if (JSON.stringify(message.hashes) !== JSON.stringify(hashes)) throw new Error('worker 策略 SHA256 与启动快照不一致');
              slot.ready = true; dispatch();
            } else if (message.type === 'result' && slot.job && message.match.id === slot.job.id) {
              matches.push(message.match);
              console.error(`[${matches.length}/${jobs.length}] ${message.match.mapMode} seed=${message.match.seedIndex} seat=${message.match.seat} ${message.match.outcome}`);
              clearTimeout(slot.timer);
              if (matches.length === jobs.length) { finished = true; resolve(); } else dispatch();
            } else throw new Error(`worker ${i} 协议错误`);
          } catch (error) { fail(error); }
        });
      }
    });
  } finally {
    finished = true;
    for (const slot of workers) clearTimeout(slot.timer);
    await Promise.all(workers.map(slot => slot.worker.terminate()));
    if (onSignal) { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); }
  }
  if (JSON.stringify(hashes) !== JSON.stringify(fingerprints())) throw new Error('评估期间源文件变化，拒绝保存混合版本报告');
  matches.sort((a, b) => a.id - b.id);
  const wallMs = performance.now() - start;
  const report = { createdAt, config, opponent: config.self ? 'bot/policy.cjs (self)' : `training/${config.opponent}/policy.cjs`,
    environment: { node: process.version, versions: process.versions, platform: process.platform, arch: process.arch,
      cpuModel: os.cpus()[0]?.model, logicalCPUs: os.cpus().length, availableParallelism: os.availableParallelism?.(), totalMemoryBytes: os.totalmem() },
    sha256: hashes, wallMs, throughput: { gamesPerSecond: matches.length * 1000 / wallMs,
      engineTicksPerSecond: matches.reduce((sum, g) => sum + g.turns, 0) * 1000 / wallMs },
    semantics: { ticks: '引擎 tick；policy 决策前每 tick 采样，并补采最终帧',
      checkpoints: '精确 tick；提前结束或未达到采样点记 null，均值仅包含有效样本',
      ordinaryLand: 'grid === playerId，不含主城、建筑及沼泽',
      buildingActions: 'policy 提议与引擎确认分开记录',
      timeout: '达到 turns 且 ended=false 为 timeout_unresolved，不依据兵力判胜' },
    summary: summarize(matches), matches };
  fs.mkdirSync(path.dirname(config.output), { recursive: true });
  fs.writeFileSync(config.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: config.output, wallMs, throughput: report.throughput, summary: report.summary }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
