// Exercise the real runner in child processes, including deliberately broken copies.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(rootDir, 'scripts/test-asset-versioning.mjs'), 'utf8');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roka-asset-exit-'));
try {
  for (const [label, from, to, expected, marker] of [
    ['normal', null, null, 0, '全部断言通过'],
    [
      'exception',
      '  ensureBuild();',
      "  throw new Error('injected runner exception');",
      1,
      'injected runner exception',
    ],
    ['assertion', 'assert(home.status === 200,', 'assert(false,', 1, '断言失败：首页 / 返回 200'],
  ]) {
    let script = source.replace(
      "path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')",
      JSON.stringify(rootDir),
    );
    if (from) {
      assert(script.includes(from), `mutation target exists: ${label}`);
      script = script.replace(from, to);
    }
    const entry = path.join(tempDir, `${label}.mjs`);
    fs.writeFileSync(entry, script);
    const result = spawnSync(process.execPath, [entry], { cwd: rootDir, encoding: 'utf8', timeout: 65_000 });
    const output = result.stdout + result.stderr;
    assert.ifError(result.error);
    assert.equal(result.signal, null, output);
    assert.equal(result.status, expected, output);
    assert(output.includes(marker), output);
    if (expected !== 0) assert(!output.includes('全部断言通过'), output);
    console.log(`[test-asset-versioning-exit] ${label}: exit ${result.status}, expected output verified`);
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
