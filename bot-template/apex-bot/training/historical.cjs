'use strict';

const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const BASELINE_COMMIT = '33fdac943675ee840dc1d5860e7d73dadae5507c';
const snapshots = {
  apex: { tree: 'apex-bot', files: ['strategy.js', 'bot'] },
  v2: { tree: 'bot-2.0', files: ['strategy.js', 'bot'] },
};
const cached = new Map();

function loadHistorical(id, entry = 'strategy.js') {
  if (!Object.hasOwn(snapshots, id)) throw new Error(`Unknown historical bot: ${id}`);
  if (!cached.has(id)) {
    const { tree, files } = snapshots[id];
    const directory = mkdtempSync(path.join(tmpdir(), `roka-${id}-baseline-`));
    const cleanup = () => rmSync(directory, { recursive: true, force: true });
    try {
      const archive = execFileSync('git', ['archive', `${BASELINE_COMMIT}:bot-template/${tree}`, ...files], {
        cwd: ROOT,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      execFileSync('tar', ['-xf', '-', '-C', directory], { input: archive });
    } catch (error) {
      cleanup();
      throw new Error(`Cannot load frozen ${id} control at ${BASELINE_COMMIT}; Git history and tar are required`, { cause: error });
    }
    process.once('exit', cleanup);
    cached.set(id, directory);
  }
  return require(path.join(cached.get(id), entry));
}

module.exports = { BASELINE_COMMIT, loadHistorical };
