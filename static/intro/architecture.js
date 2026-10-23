import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
export async function materials(load) {
  const asset = '';
  async function pbr(id, color, scale) {
    const maps = await Promise.all(
      ['diff', 'nor_gl', 'rough'].map((k) => load.loadAsync(asset + id + '-' + k + '.jpg')),
    );
    maps.forEach((m) => {
      m.wrapS = m.wrapT = T.RepeatWrapping;
      m.anisotropy = 4;
    });
    maps[0].colorSpace = T.SRGBColorSpace;
    return new T.MeshStandardMaterial({
      map: maps[0],
      normalMap: maps[1],
      roughnessMap: maps[2],
      normalScale: new T.Vector2(scale, scale),
      color,
      roughness: 1,
      metalness: 0,
      vertexColors: true,
    });
  }
  return {
    stone: await pbr('medieval_blocks_03', 0xc3b8a1, 0.75),
    roof: await pbr('slate_floor_02', 0x777d82, 0.7),
    wood: await pbr('wood_planks_grey', 0x76624a, 0.6),
    iron: new T.MeshStandardMaterial({ color: 0x24282a, roughness: 0.7, metalness: 0.55 }),
  };
}
function colorUv(g, tint = 1) {
  const p = g.attributes.position,
    n = g.attributes.normal,
    uv = new Float32Array(p.count * 2),
    col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i),
      nx = Math.abs(n.getX(i)),
      ny = Math.abs(n.getY(i));
    uv[i * 2] = (nx > 0.6 ? z : x) * 0.4;
    uv[i * 2 + 1] = (ny > 0.6 ? z : y) * 0.4;
    const v = tint * (0.87 + 0.13 * Math.min(1, y / 4));
    col.set([v, v * 0.99, v * 0.97], i * 3);
  }
  g.setAttribute('uv', new T.BufferAttribute(uv, 2));
  g.setAttribute('color', new T.BufferAttribute(col, 3));
  return g;
}
const prototypes = new WeakMap();
export function fortress(mats, large = true, staticBuilding = false) {
  let cache = prototypes.get(mats);
  if (!cache) {
    cache = new Map();
    prototypes.set(mats, cache);
  }
  const key = large ? 'large' : 'post';
  if (staticBuilding && cache.has(key)) {
    const original = cache.get(key),
      root = original.root.clone(true),
      parts = original.parts.map((p) => ({
        ...p,
        mesh: root.children[original.root.children.indexOf(p.mesh)],
      })),
      scaffold = root.children[original.root.children.indexOf(original.scaffold)];
    return {
      root,
      parts,
      scaffold,
      height: original.height,
      update() {
        scaffold.visible = false;
        for (const p of parts) p.mesh.visible = true;
      },
    };
  }
  const root = new T.Group(),
    batches = new Map();
  function add(g, m, pos, stage = 0, rotation = 0, tint = 1) {
    if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
    g.rotateY(rotation);
    g.translate(...pos);
    colorUv(g, tint);
    if (staticBuilding) stage = 0;
    const key = m + '-' + stage;
    if (!batches.has(key)) batches.set(key, { m, stage, items: [] });
    batches.get(key).items.push(g);
  }
  function box(w, h, d, x, y, z, stage, m = 'stone', tint = 1) {
    add(new T.BoxGeometry(w, h, d), m, [x, y, z], stage, 0, tint);
  }
  function wall(x1, z1, x2, z2, height, stageBase, door = false, windows = false) {
    const len = Math.hypot(x2 - x1, z2 - z1),
      dx = (x2 - x1) / len,
      dz = (z2 - z1) / len,
      angle = -Math.atan2(dz, dx),
      rows = Math.ceil(height / 0.56),
      holes = [];
    if (door) holes.push([-0.77, 0.77, 0, 2.28]);
    if (windows)
      for (const x of [-0.29 * len, 0.29 * len]) {
        holes.push([x - 0.26, x + 0.26, 2.3, 3.28]);
        if (height > 6) holes.push([x - 0.26, x + 0.26, 5.05, 6.03]);
      }
    function subtract(r, h) {
      const [l, rr, b, t] = r,
        [hl, hr, hb, ht] = h;
      if (rr <= hl || l >= hr || t <= hb || b >= ht) return [r];
      const o = [];
      if (l < hl) o.push([l, hl, b, t]);
      if (rr > hr) o.push([hr, rr, b, t]);
      const il = Math.max(l, hl),
        ir = Math.min(rr, hr);
      if (b < hb) o.push([il, ir, b, hb]);
      if (t > ht) o.push([il, ir, ht, t]);
      return o;
    }
    for (let row = 0; row < rows; row++) {
      const hh = height / rows;
      let at = 0,
        k = 0;
      while (at < len - 0.01) {
        const width = Math.min(len - at, k === 0 && row % 2 ? 0.37 : 0.72 + 0.09 * Math.sin(k * 2.4 + row)),
          local = at + width / 2 - len / 2;
        let pieces = [
          [local - width / 2 + 0.008, local + width / 2 - 0.008, row * hh + 0.007, (row + 1) * hh - 0.007],
        ];
        for (const hole of holes) pieces = pieces.flatMap((r) => subtract(r, hole));
        for (const [l, r, b, t] of pieces)
          if (r - l > 0.014 && t - b > 0.014)
            add(
              new T.BoxGeometry(r - l, t - b, 0.6),
              'stone',
              [(x1 + x2) / 2 + ((l + r) / 2) * dx, (t + b) / 2, (z1 + z2) / 2 + ((l + r) / 2) * dz],
              stageBase + row,
              angle,
              0.96 + 0.05 * Math.sin(k * 6 + row),
            );
        at += width;
        k++;
      }
    }
    // Thin dressed-stone reveals and timber shutters give rectangular openings depth.
    for (const [l, r, b, t] of holes) {
      const cx = (l + r) / 2,
        cy = (b + t) / 2,
        stage = stageBase + Math.floor(t / 0.56);
      for (const x of [l - 0.065, r + 0.065])
        add(
          new T.BoxGeometry(0.13, t - b + 0.24, 0.72),
          'stone',
          [(x1 + x2) / 2 + x * dx, cy, (z1 + z2) / 2 + x * dz],
          stage,
          angle,
          1.05,
        );
      add(
        new T.BoxGeometry(r - l + 0.38, 0.19, 0.76),
        'stone',
        [(x1 + x2) / 2 + cx * dx, t + 0.095, (z1 + z2) / 2 + cx * dz],
        stage,
        angle,
        1.08,
      );
      if (b > 0) {
        add(
          new T.BoxGeometry(r - l + 0.34, 0.14, 0.85),
          'stone',
          [(x1 + x2) / 2 + cx * dx, b - 0.07, (z1 + z2) / 2 + cx * dz],
          stage,
          angle,
          1.04,
        );
        add(
          new T.BoxGeometry(r - l - 0.05, t - b - 0.06, 0.09),
          'wood',
          [(x1 + x2) / 2 + cx * dx, cy, (z1 + z2) / 2 + cx * dz],
          stage,
          angle,
          0.35,
        );
      }
    }
  }
  function roof(cx, cy, cz, w, d, h, stage) {
    const points = [
        [-w / 2, 0, -d / 2],
        [w / 2, 0, -d / 2],
        [0, h, -d / 2],
        [-w / 2, 0, d / 2],
        [w / 2, 0, d / 2],
        [0, h, d / 2],
      ],
      ix = [0, 1, 2, 3, 5, 4, 0, 2, 5, 0, 5, 3, 2, 1, 4, 2, 4, 5];
    let pos = [];
    for (let q = 6; q < ix.length; q += 3)
      for (const i of [ix[q], ix[q + 2], ix[q + 1]]) pos.push(...points[i]);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    add(g, 'roof', [cx, cy, cz], stage);
    const gp = [];
    for (const i of [0, 2, 1, 3, 4, 5]) gp.push(...points[i]);
    const gg = new T.BufferGeometry();
    gg.setAttribute('position', new T.Float32BufferAttribute(gp, 3));
    gg.computeVertexNormals();
    add(gg, 'wood', [cx, cy, cz], stage);
    for (const zz of [-d / 2, d / 2]) {
      for (const sign of [-1, 1]) {
        const beam = new T.BoxGeometry(Math.hypot(w / 2, h), 0.17, 0.2);
        beam.rotateZ(-sign * Math.atan2(h, w / 2));
        add(beam, 'wood', [cx + (sign * w) / 4, cy + h / 2, cz + zz], stage + 0.1);
      }
    }
  }
  const w = large ? 6.2 : 5.0,
    d = large ? 5.2 : 4.2,
    h = large ? 7.3 : 4.0;
  box(w + 0.6, 0.34, d + 0.6, 0, 0.17, 0, 0);
  wall(-w / 2, -d / 2, w / 2, -d / 2, h, 1, true, true);
  wall(w / 2, -d / 2, w / 2, d / 2, h, 1, false, true);
  wall(w / 2, d / 2, -w / 2, d / 2, h, 1, false, true);
  wall(-w / 2, d / 2, -w / 2, -d / 2, h, 1, false, true);
  box(1.45, 2.1, 0.18, 0, 1.08, -d / 2 + 0.18, 2, 'wood', 0.65);
  for (const yy of [0.55, 1.55]) box(1.48, 0.09, 0.09, 0, yy, -d / 2 + 0.05, 3, 'iron');
  roof(0, h + 0.04, 0, w + 0.65, d + 0.65, large ? 1.9 : 1.4, large ? 16 : 10);
  if (large) {
    const ow = 10.3,
      od = 8.8;
    wall(-ow / 2, -od / 2, ow / 2, -od / 2, 2.8, 1, true);
    wall(ow / 2, -od / 2, ow / 2, od / 2, 2.8, 1);
    wall(ow / 2, od / 2, -ow / 2, od / 2, 2.8, 1);
    wall(-ow / 2, od / 2, -ow / 2, -od / 2, 2.8, 1);
    for (const x of [-4.65, 4.65])
      for (const z of [-3.85, 3.85]) {
        const th = 5.3 + (z > 0 ? 0.7 : 0);
        for (let row = 0; row < Math.ceil(th / 0.55); row++) {
          const hh = th / Math.ceil(th / 0.55);
          for (const xx of [-0.73, 0, 0.73])
            box(0.72, hh - 0.015, 2.18, x + xx, (row + 0.5) * hh, z, 1 + row);
        }
        box(2.44, 0.22, 2.44, x, th - 0.04, z, 9);
        for (let k = 0; k < 3; k++)
          for (const side of [-1, 1]) {
            box(0.43, 0.62, 0.48, x + (k - 1) * 0.78, th + 0.37, z + side * 1.0, 11);
            box(0.48, 0.62, 0.43, x + side * 1.0, th + 0.37, z + (k - 1) * 0.78, 11);
          }
        box(0.3, 1.1, 0.1, x, th * 0.64, z - 1.11, 8, 'wood', 0.3);
      }
    for (let k = 0; k < 11; k++)
      for (const side of [-1, 1]) box(0.48, 0.6, 0.58, -4.7 + k * 0.94, 3.04, (side * od) / 2, 10);
    for (let k = 0; k < 7; k++)
      for (const side of [-1, 1]) box(0.58, 0.6, 0.48, (side * ow) / 2, 3.04, -2.85 + k * 0.95, 10);
    for (const side of [-1, 1]) box(0.5, h + 0.3, 0.5, side * (w / 2 + 0.05), (h + 0.3) / 2, 0, 12);
  }
  const parts = [];
  for (const m of new Set([...batches.values()].map((b) => b.m))) {
    const groups = [...batches.values()].filter((b) => b.m === m).sort((a, b) => a.stage - b.stage),
      ranges = [];
    let count = 0;
    const geometries = [];
    for (const b of groups) {
      const g = mergeGeometries(b.items);
      for (const item of b.items) item.dispose();
      count += g.index.count;
      ranges.push({ stage: b.stage, count });
      geometries.push(g);
    }
    const geometry = mergeGeometries(geometries);
    for (const g of geometries) g.dispose();
    const mesh = new T.Mesh(geometry, mats[m]);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    parts.push({ mesh, ranges });
  }
  const scaffold = new T.Group(),
    sg = [];
  for (const x of [-(w / 2 + 1), w / 2 + 1])
    for (const z of [-(d / 2 + 1), d / 2 + 1]) {
      let g = new T.CylinderGeometry(0.075, 0.1, h + 1, 7);
      g.translate(x, (h + 1) / 2, z);
      colorUv(g);
      sg.push(g);
    }
  for (const yy of [1.7, 3.4, 5.1, 6.8]) {
    if (yy > h + 0.8) continue;
    for (const zz of [-(d / 2 + 1), d / 2 + 1]) {
      const g = new T.BoxGeometry(w + 2.2, 0.13, 0.18);
      g.translate(0, yy, zz);
      colorUv(g);
      sg.push(g);
    }
    for (const xx of [-(w / 2 + 1), w / 2 + 1]) {
      const g = new T.BoxGeometry(0.18, 0.13, d + 2.2);
      g.translate(xx, yy, 0);
      colorUv(g);
      sg.push(g);
    }
  }
  const sm = new T.Mesh(mergeGeometries(sg), mats.wood);
  for (const g of sg) g.dispose();
  sm.castShadow = true;
  scaffold.add(sm);
  root.add(scaffold);
  const maxStage = large ? 16 : 10;
  if (staticBuilding) cache.set(key, { root, parts, scaffold, height: h + 2 });
  return {
    root,
    parts,
    scaffold,
    height: h + 2,
    update(progress = 1) {
      for (const p of parts) {
        let count = 0;
        for (const r of p.ranges) if (progress >= (r.stage + 0.5) / (maxStage + 1)) count = r.count;
        p.mesh.geometry.setDrawRange(0, count);
        p.mesh.visible = count > 0;
      }
      scaffold.visible = progress > 0.06 && progress < 0.96;
    },
  };
}
