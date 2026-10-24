// One-time asset preparation from the backed-up film project; normal builds are offline.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NodeIO, Format } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { reorder } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/intro/import-intro-assets.mjs /path/to/roka-trailer');
const out = path.resolve('static/intro/assets');
await fs.mkdir(out, { recursive: true });
const manifest = { version: 1, width: 1920, height: 1080, duration: 120, files: {}, images: {}, fonts: {} };
const bytes = {};
async function emit(name, data) {
  const ext = path.extname(name),
    base = path.basename(name, ext),
    hash = createHash('sha256').update(data).digest('hex').slice(0, 16),
    file = `${base}.${hash}${ext}`;
  await fs.writeFile(path.join(out, file), data);
  bytes[file] = data.length;
  return `/intro/assets/${file}`;
}
async function copy(name, loc) {
  manifest.files[name] = await emit(name, await fs.readFile(loc));
}
await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression])
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
for (const [name, location] of [
  ['knight-hero', `${source}/v3/assets/knight-hero.glb`],
  ['knight-lod', `${source}/v2/assets/knight-lod.glb`],
  ['knight-crowd', `${source}/v2/assets/knight-crowd.glb`],
]) {
  const doc = await io.read(location);
  await doc.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }));
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const { json, resources } = await io.writeJSON(doc, { format: Format.GLTF, basename: name });
  const remap = {};
  for (const [uri, data] of Object.entries(resources))
    remap[uri] = await emit(
      path.extname(uri) === '.bin' ? `${name}.bin` : `knight-texture${path.extname(uri)}`,
      data,
    );
  for (const item of [...(json.buffers || []), ...(json.images || [])])
    if (item.uri && remap[item.uri]) item.uri = remap[item.uri];
  manifest.files[`${name}.glb`] = await emit(`${name}.gltf`, Buffer.from(JSON.stringify(json)));
}
for (const name of [
  'world.json',
  'motion-profile.json',
  'rock_face_03-diff.jpg',
  'rock_face_03-nor_gl.jpg',
  'rock_face_03-rough.jpg',
  'brown_mud_02-diff.jpg',
  'medieval_blocks_03-diff.jpg',
  'medieval_blocks_03-nor_gl.jpg',
  'medieval_blocks_03-rough.jpg',
  'slate_floor_02-diff.jpg',
  'slate_floor_02-nor_gl.jpg',
  'slate_floor_02-rough.jpg',
  'wood_planks_grey-diff.jpg',
  'wood_planks_grey-nor_gl.jpg',
  'wood_planks_grey-rough.jpg',
])
  await copy(name, `${source}/v5/assets/${name}`);
for (const name of ['ground.jpg', 'ground-normal.jpg', 'sky.hdr'])
  await copy(name, `${source}/v2/assets/${name}`);
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(
  JSON.stringify(
    {
      files: Object.keys(bytes).length,
      bytes: Object.values(bytes).reduce((a, b) => a + b, 0),
      modelFiles: manifest.files['knight-hero.glb'],
    },
    null,
    2,
  ),
);
