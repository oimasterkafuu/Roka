import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
const root = 'static/intro';
const assetDir = `${root}/assets`;
const manifest = JSON.parse(await fs.readFile(`${assetDir}/manifest.json`));
async function indexAsset(name) {
  const data = await fs.readFile(`${assetDir}/${name}`),
    ext = path.extname(name),
    stem = path.basename(name, ext),
    hash = createHash('sha256').update(data).digest('hex').slice(0, 16),
    file = `${stem}.${hash}${ext}`;
  await fs.writeFile(`${assetDir}/${file}`, data);
  return `/intro/assets/${file}`;
}
for (const name of ['plan.json', 'replays.json']) manifest.files[name] = await indexAsset(name);
for (const name of ['serif', 'cn', 'latin', 'sans', 'quicksand'])
  manifest.fonts[name] = await indexAsset(`intro-${name}.woff2`);
await fs.writeFile(`${assetDir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
await build({
  entryPoints: [`${root}/player-source.js`],
  outfile: `${root}/player.js`,
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  legalComments: 'eof',
});
// Normalize insignificant trailing whitespace in embedded upstream GLSL.
await fs.writeFile(
  `${root}/player.js`,
  (await fs.readFile(`${root}/player.js`, 'utf8')).replace(/[ \t]+$/gm, ''),
);
// The static server negotiates precompressed sidecars; no runtime compression cost.
for (const dir of [root, `${root}/assets`])
  for (const file of await fs.readdir(dir)) {
    if (!/\.(?:js|json|gltf|bin|hdr)$/.test(file)) continue;
    const loc = path.join(dir, file),
      data = await fs.readFile(loc);
    await fs.writeFile(loc + '.gz', gzipSync(data, { level: 9 }));
    await fs.writeFile(
      loc + '.br',
      brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
    );
  }
console.log('Realtime intro built (no video frames).');
