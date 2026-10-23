// Deterministic landforms: shared ridge links and organically merged marsh basins.
export function createLandform(data) {
  const { n, m, cellX: cx, cellZ: cz } = data,
    g = data.frame.grid;
  const hash = (a, b = 0) => {
      let v = Math.sin(a * 127.1 + b * 311.7 + 13.3) * 43758.5453123;
      return v - Math.floor(v);
    },
    sat = (x) => Math.max(0, Math.min(1, x)),
    smooth = (x) => {
      x = sat(x);
      return x * x * (3 - 2 * x);
    };
  function noise(x, z) {
    let i = Math.floor(x),
      j = Math.floor(z),
      u = smooth(x - i),
      v = smooth(z - j);
    return (
      (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) +
      (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v
    );
  }
  function fbm(x, z) {
    return (
      noise(x, z) * 0.57 +
      noise(x * 2.13 + 7, z * 2.13 - 11) * 0.28 +
      noise(x * 4.37 - 9, z * 4.37 + 4) * 0.15
    );
  }
  const mountain = (i, j) => i >= 0 && j >= 0 && i < n && j < m && g[i * m + j] === 201,
    swamp = (i, j) =>
      i >= 0 &&
      j >= 0 &&
      i < n &&
      j < m &&
      (g[i * m + j] === 204 || (g[i * m + j] >= 150 && g[i * m + j] < 200));
  const mountains = new Map(),
    wetlands = new Map(),
    links = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      let k = i * m + j;
      if (mountain(i, j)) {
        const degree = [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ].filter(([di, dj]) => mountain(i + di, j + dj)).length;
        mountains.set(k, {
          x: j + (hash(k, 6) - 0.5) * 0.48,
          z: i + (hash(k, 7) - 0.5) * 0.48,
          h: 5 + hash(k, 8) * 10,
          rx: 0.34 + hash(k, 9) * 0.2,
          rz: 0.34 + hash(k, 10) * 0.2,
          a: hash(k, 11) * Math.PI,
          power: 0.52 + hash(k, 12) * 0.95,
          degree,
        });
      }
      if (swamp(i, j))
        wetlands.set(k, {
          x: j + (hash(k, 41) - 0.5) * 0.18,
          z: i + (hash(k, 42) - 0.5) * 0.18,
          a: hash(k, 43) * 6.28,
          rx: 0.33 + hash(k, 44) * 0.22,
          rz: 0.24 + hash(k, 45) * 0.29,
          lobes: 1 + Math.floor(hash(k, 46) * 3),
          phase: hash(k, 47) * 6.28,
        });
    }
  for (const [k, a] of mountains) {
    let i = Math.floor(k / m),
      j = k % m;
    for (const [di, dj] of [
      [1, 0],
      [0, 1],
    ])
      if (mountain(i + di, j + dj)) {
        const b = mountains.get((i + di) * m + j + dj);
        links.push({ a, b });
      }
  }
  function wetness(x, z) {
    let xf = x / cx + m / 2 - 0.5,
      zf = z / cz + n / 2 - 0.5,
      ci = Math.round(zf),
      cj = Math.round(xf),
      value = 0;
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++) {
        const k = (ci + di) * m + cj + dj,
          a = wetlands.get(k);
        if (!a) continue;
        let dx = xf - a.x,
          dz = zf - a.z,
          xx = dx * Math.cos(a.a) + dz * Math.sin(a.a),
          zz = -dx * Math.sin(a.a) + dz * Math.cos(a.a);
        let angle = Math.atan2(zz, xx),
          edge = 1 + 0.13 * Math.sin(angle * 3 + a.phase) + 0.08 * Math.sin(angle * 5 - a.phase);
        let radius = Math.hypot(xx / a.rx, zz / a.rz) / edge;
        let w = smooth((1.3 - radius) / 0.65);
        for (let q = 1; q < a.lobes; q++) {
          const lx = xx - (q % 2 ? 1 : -1) * a.rx * 0.45,
            lz = zz + a.rz * 0.35;
          w = Math.max(w, smooth((1.1 - Math.hypot(lx / (a.rx * 0.65), lz / (a.rz * 0.73))) / 0.55));
        }
        value = Math.max(value, w);
      }
    return sat(value + (fbm(x * 0.44, z * 0.44) - 0.5) * 0.12 * value);
  }
  function height(x, z) {
    let xf = x / cx + m / 2 - 0.5,
      zf = z / cz + n / 2 - 0.5,
      ci = Math.round(zf),
      cj = Math.round(xf),
      flat = 0.045 * Math.sin(x * 0.18) * Math.cos(z * 0.21);
    if (ci < 0 || cj < 0 || ci >= n || cj >= m) return 0;

    let h = 0;
    const smx = (a, b, k = 1.2) => Math.max(a, b) + Math.pow(Math.max(0, k - Math.abs(a - b)), 2) / (4 * k);
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++) {
        const a = mountains.get((ci + di) * m + cj + dj);
        if (!a) continue;
        const dx = xf - a.x,
          dz = zf - a.z,
          xx = dx * Math.cos(a.a) + dz * Math.sin(a.a),
          zz = -dx * Math.sin(a.a) + dz * Math.cos(a.a),
          r =
            Math.hypot(xx / a.rx, zz / a.rz) +
            0.055 * Math.sin(Math.atan2(zz, xx) * 3 + a.a) +
            0.035 * Math.sin(Math.atan2(zz, xx) * 5 - a.a);
        let mass = a.h * Math.pow(Math.max(0, 1 - r), a.power);
        if (mass > 0.001) h = smx(h, mass, 0.85);
        // A shared saddle joins adjacent cells; the same endpoints are used on both sides.
        for (const [ni, nj] of [
          [ci + di + 1, cj + dj],
          [ci + di, cj + dj + 1],
        ]) {
          if (!mountain(ni, nj)) continue;
          const b = mountains.get(ni * m + nj);
          let vx = b.x - a.x,
            vz = b.z - a.z,
            t = sat(((xf - a.x) * vx + (zf - a.z) * vz) / (vx * vx + vz * vz)),
            px = a.x + t * vx,
            pz = a.z + t * vz;
          const bend = Math.sin(t * Math.PI) * 0.3 * (hash((ci + di) * m + cj + dj, 55) - 0.5);
          px += vz * bend;
          pz -= vx * bend;
          const dist = Math.hypot(xf - px, zf - pz),
            width = (0.24 + 0.13 * hash((ci + di) * m + cj + dj, 57)) * (0.83 + 0.22 * Math.sin(t * Math.PI)),
            ridge =
              (a.h * (1 - t) + b.h * t) *
              (0.68 + 0.17 * Math.cos(t * Math.PI * 2)) *
              Math.pow(Math.max(0, 1 - dist / width), 0.8);
          if (ridge > 0.001) h = smx(h, ridge, 1.4);
        }
      }
    if (h < 0.005) return flat - wetness(x, z) * 0.32;
    let edge = 1;
    let erosion = 0.84 + 0.25 * fbm(x * 0.19, z * 0.19) + 0.09 * (noise(x * 0.85, z * 0.85) - 0.5);
    let strata = 0.07 * Math.sin(h * 2.1 + fbm(x * 0.6, z * 0.6) * 4);
    return Math.max(flat, (h * erosion + strata * smooth(h / 2)) * edge);
  }
  return {
    height,
    wetness,
    noise,
    fbm,
    hash,
    stats: { mountainCells: mountains.size, sharedRidgeLinks: links.length, wetlandCells: wetlands.size },
  };
}
