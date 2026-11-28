import { build } from 'esbuild';
import path from 'node:path';

await build({
  entryPoints: ['src/replay-worker.js'],
  outfile: 'static/main/replay-worker.bundle.js',
  bundle: true,
  minify: true,
  platform: 'browser',
  target: 'es2022',
  alias: { 'node:crypto': path.resolve('src/game-engine/browser-crypto.js') },
});
