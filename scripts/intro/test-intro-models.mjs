import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression])
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const manifest = JSON.parse(await fs.readFile('static/intro/assets/manifest.json'));
const originals = process.argv[2];
function triangles(doc) {
  const result = [];
  for (const mesh of doc.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      const semantics = primitive.listSemantics().sort(),
        attrs = semantics.map((s) => primitive.getAttribute(s)),
        size = attrs[0].getCount();
      const vertices = [];
      for (let i = 0; i < size; i++) {
        const tuple = attrs.flatMap((a) =>
          Array.from(a.getArray().slice(i * a.getElementSize(), (i + 1) * a.getElementSize())),
        );
        vertices.push(createHash('sha256').update(JSON.stringify(tuple)).digest('hex'));
      }
      const indices = primitive.getIndices()?.getArray() || Array.from({ length: size }, (_, i) => i);
      for (let i = 0; i < indices.length; i += 3) {
        const t = [vertices[indices[i]], vertices[indices[i + 1]], vertices[indices[i + 2]]];
        result.push([t.join(''), [t[1], t[2], t[0]].join(''), [t[2], t[0], t[1]].join('')].sort()[0]);
      }
    }
  return result.sort();
}
function animations(doc) {
  return doc
    .getRoot()
    .listAnimations()
    .map((a) => [
      a.getName(),
      a
        .listChannels()
        .map((c) => [
          c.getTargetNode().getName(),
          c.getTargetPath(),
          Array.from(c.getSampler().getInput().getArray()),
          Array.from(c.getSampler().getOutput().getArray()),
        ]),
    ]);
}
for (const name of ['knight-hero', 'knight-lod', 'knight-crowd']) {
  const json = JSON.parse(await fs.readFile('static' + manifest.files[name + '.glb']));
  const resources = {};
  for (const r of [...json.buffers, ...json.images])
    if (r.uri) resources[r.uri] = await fs.readFile('static' + r.uri);
  const decoded = await io.readJSON({ json, resources });
  const counts = decoded
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives().map((p) => p.getIndices().getCount() / 3));
  if (originals) {
    const source = await io.read(
      path.join(originals, name === 'knight-hero' ? 'v3/assets' : 'v2/assets', name + '.glb'),
    );
    assert.deepEqual(
      triangles(decoded),
      triangles(source),
      name + ' every triangle/vertex attribute lossless',
    );
    assert.deepEqual(animations(decoded), animations(source), name + ' unchanged animation channels');
  }
  console.log(
    name,
    counts.reduce((a, b) => a + b, 0),
    'triangles',
    originals ? 'lossless attributes and animation verified' : 'decoded',
  );
}
