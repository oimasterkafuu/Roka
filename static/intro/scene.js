import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Motion } from './motion.js';
import { createIntroAssetLoader } from './asset-loading.js';
import { createLandform } from './landform.js';
import { materials, fortress } from './architecture.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
export async function createScene({ assets, signal, onStatus = () => {}, nativeResolution = false }) {
  const manager = new T.LoadingManager();
  const assetLoader = createIntroAssetLoader({ files: assets.files, signal });
  const resources = new Set(),
    roots = new Set();
  let disposed = false,
    rendererRef;
  function release(resource) {
    if (resource?.isObject3D) {
      resource.traverse((o) => {
        if (o.geometry) resources.add(o.geometry);
        if (o.skeleton) resources.add(o.skeleton);
        for (const mat of Array.isArray(o.material) ? o.material : [o.material])
          if (mat) {
            resources.add(mat);
            for (const value of Object.values(mat)) if (value?.isTexture) resources.add(value);
          }
      });
    } else if (resource?.dispose) resources.add(resource);
  }
  function own(resource) {
    if (disposed) {
      release(resource);
      for (const r of resources) {
        r.dispose();
        if (r.isTexture) r.image?.close?.();
      }
      resources.clear();
    } else if (resource?.isObject3D) roots.add(resource);
    else resources.add(resource);
    return resource;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', abort);
    manager.abort();
    assetLoader.dispose();
    for (const root of roots) release(root);
    for (const r of resources) {
      r.dispose();
      if (r.isTexture) r.image?.close?.();
    }
    resources.clear();
    roots.clear();
    rendererRef?.forceContextLoss();
    rendererRef?.domElement.remove();
  }
  const abort = () => dispose();
  signal?.addEventListener('abort', abort, { once: true });
  const check = () => {
    if (disposed || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  const json = assetLoader.json;
  function tracked(loader) {
    const original = loader.loadAsync.bind(loader);
    loader.loadAsync = async (...args) => {
      const r = await original(...args);
      if (r.scene) own(r.scene);
      else own(r);
      check();
      return r;
    };
    return loader;
  }
  try {
    check();
    const W = 1600,
      H = 900,
      BASE = '',
      ASSET = '';

    manager.onProgress = (url, loaded, total) => onStatus(`载入场景素材 ${loaded}/${total}`);

    const motionProfile = await json('motion-profile.json');
    const data = await json('world.json');
    const { n, m, cellX: CX, cellZ: CZ, focusCell, palette } = data,
      grid = data.frame.grid;
    const worldWidth = m * CX,
      worldDepth = n * CZ;
    const renderer = own(
      new T.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      }),
    );
    rendererRef = renderer;
    let contextLost = false;
    const lost = () => {
      if (!disposed) contextLost = true;
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    own({
      dispose() {
        renderer.domElement.removeEventListener('webglcontextlost', lost);
      },
    });
    renderer.setSize(W, H);
    renderer.setPixelRatio(1);
    renderer.info.autoReset = false;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.NoToneMapping;
    const scene = own(new T.Scene());
    scene.fog = new T.FogExp2(0x6c7777, 0.0018);
    const camera = new T.PerspectiveCamera(43, W / H, 0.15, 1500),
      ortho = new T.OrthographicCamera((-8 * W) / H, (8 * W) / H, 8, -8, 0.1, 2000);
    const sun = new T.DirectionalLight(0xffddaa, 3.6);
    sun.position.set(-90, 115, -120);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -180, right: 180, top: 180, bottom: -180, near: 2, far: 500 });
    sun.shadow.bias = -0.0003;
    scene.add(sun, sun.target);
    scene.add(new T.HemisphereLight(0xb7d7e2, 0x56442e, 0.8));
    const fill = new T.DirectionalLight(0xa4c3df, 0.6);
    fill.position.set(60, 40, 80);
    scene.add(fill);
    const sky = await tracked(new HDRLoader(manager)).loadAsync(await assetLoader.blobURL(BASE + 'sky.hdr'));
    sky.mapping = T.EquirectangularReflectionMapping;
    scene.background = sky;
    scene.environment = sky;
    scene.environmentIntensity = 0.5;
    scene.backgroundIntensity = 0.48;
    scene.backgroundRotation.y = 2.8;
    // Fetch through the commit-pinned runtime before decoding. Flip at decode time because
    // WebGL ignores UNPACK_FLIP_Y_WEBGL for ImageBitmap sources.
    const bitmapLoader = new T.ImageBitmapLoader(manager).setOptions({
      imageOrientation: 'flipY',
      premultiplyAlpha: 'none',
    });
    const texLoader = {
      async loadAsync(name) {
        const image = await bitmapLoader.loadAsync(await assetLoader.blobURL(name));
        const texture = own(new T.Texture(image));
        texture.flipY = false;
        texture.needsUpdate = true;
        check();
        return texture;
      },
    };
    const groundTex = await texLoader.loadAsync(BASE + 'ground.jpg'),
      normalTex = await texLoader.loadAsync(BASE + 'ground-normal.jpg');
    groundTex.colorSpace = T.SRGBColorSpace;
    for (const tx of [groundTex, normalTex]) {
      tx.wrapS = tx.wrapT = T.RepeatWrapping;
      tx.repeat.set(26, 26);
      tx.anisotropy = 4;
    }
    const smooth = (x) => {
      x = T.MathUtils.clamp(x, 0, 1);
      return x * x * (3 - 2 * x);
    };
    const lerp = T.MathUtils.lerp;
    function hash(a, b = 0) {
      let v = Math.sin(a * 127.1 + b * 311.7 + 13.3) * 43758.5453123;
      return v - Math.floor(v);
    }
    function cellPos(index) {
      const i = Math.floor(index / m),
        j = index % m;
      return new T.Vector3((j + 0.5 - m / 2) * CX, 0, (i + 0.5 - n / 2) * CZ);
    }
    const focus = cellPos(focusCell),
      heroBase = focus.clone().add(new T.Vector3(0, 0, -10));
    const landform = createLandform(data),
      terrainHeight = landform.height,
      wetness = landform.wetness;
    // One continuous height field creates connected, non-repeating mountain ridges.
    const terrainGeo = own(new T.PlaneGeometry(worldWidth, worldDepth, m * 12, n * 12));
    terrainGeo.rotateX(-Math.PI / 2);
    const pos = terrainGeo.attributes.position,
      origY = new Float32Array(pos.count),
      colors = new Float32Array(pos.count * 3);
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k),
        z = pos.getZ(k),
        y = terrainHeight(x, z);
      origY[k] = y;
      pos.setY(k, y);
      const i = Math.min(n - 1, Math.max(0, Math.floor(z / CZ + n / 2))),
        j = Math.min(m - 1, Math.max(0, Math.floor(x / CX + m / 2))),
        code = grid[i * m + j];
      const stone = new T.Color(0xc5c5bf),
        grass = new T.Color(0x969081),
        wet = new T.Color(0x716653);
      let col = grass
        .clone()
        .lerp(wet, wetness(x, z))
        .lerp(stone, smooth(y / 3));
      const v = 0.87 + hash(k, 18) * 0.2;
      col.multiplyScalar(v);
      col.toArray(colors, k * 3);
    }
    terrainGeo.setAttribute('color', new T.BufferAttribute(colors, 3));
    terrainGeo.computeVertexNormals();
    const wetValues = new Float32Array(pos.count);
    for (let k = 0; k < pos.count; k++) wetValues[k] = wetness(pos.getX(k), pos.getZ(k));
    terrainGeo.setAttribute('wetness', new T.BufferAttribute(wetValues, 1));
    const rockD = await texLoader.loadAsync(ASSET + 'rock_face_03-diff.jpg'),
      rockN = await texLoader.loadAsync(ASSET + 'rock_face_03-nor_gl.jpg'),
      rockR = await texLoader.loadAsync(ASSET + 'rock_face_03-rough.jpg');
    for (const tx of [rockD, rockN, rockR]) {
      tx.wrapS = tx.wrapT = T.RepeatWrapping;
      tx.anisotropy = 4;
    }
    rockD.colorSpace = T.SRGBColorSpace;
    const mudD = await texLoader.loadAsync(ASSET + 'brown_mud_02-diff.jpg');
    mudD.colorSpace = T.SRGBColorSpace;
    mudD.wrapS = mudD.wrapT = T.RepeatWrapping;
    mudD.anisotropy = 4;
    const terrainMat = new T.MeshStandardMaterial({
      map: groundTex,
      normalMap: normalTex,
      normalScale: new T.Vector2(0.75, 0.75),
      roughness: 0.95,
      vertexColors: true,
    });
    terrainMat.onBeforeCompile = (shader) => {
      shader.uniforms.rockTex = { value: rockD };
      shader.uniforms.mudTex = { value: mudD };
      shader.uniforms.rockNormal = { value: rockN };
      shader.uniforms.rockRough = { value: rockR };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float wetness;varying float vWet;varying vec3 worldP;varying vec3 worldN;',
        )
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvWet=wetness;worldP=(modelMatrix*vec4(transformed,1.)).xyz;worldN=normalize(mat3(modelMatrix)*objectNormal);',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform sampler2D rockTex,mudTex,rockNormal,rockRough;varying float vWet;varying vec3 worldP;varying vec3 worldN;',
        )
        .replace(
          '#include <map_fragment>',
          `vec3 weights=pow(abs(normalize(worldN)),vec3(5.));weights/=weights.x+weights.y+weights.z;vec3 rock=texture2D(rockTex,worldP.yz*.23).rgb*weights.x+texture2D(rockTex,worldP.xz*.23).rgb*weights.y+texture2D(rockTex,worldP.xy*.23).rgb*weights.z;vec3 earth=texture2D(map,worldP.xz*.18).rgb;float mountain=smoothstep(.3,2.4,worldP.y);float strata=.96+.04*sin(worldP.y*2.2+worldP.x*.23+worldP.z*.19);vec3 mud=texture2D(mudTex,worldP.xz*.38).rgb;diffuseColor.rgb*=mix(mix(earth,mud,vWet*.93),rock*strata,mountain);`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
vec3 rw=pow(abs(normalize(worldN)),vec3(5.));rw/=rw.x+rw.y+rw.z;vec3 rx=texture2D(rockNormal,worldP.yz*.23).xyz*2.-1.,ry=texture2D(rockNormal,worldP.xz*.23).xyz*2.-1.,rz=texture2D(rockNormal,worldP.xy*.23).xyz*2.-1.;vec3 rn=normalize(vec3(rx.z*sign(worldN.x),rx.x,rx.y)*rw.x+vec3(ry.x,ry.z*sign(worldN.y),ry.y)*rw.y+vec3(rz.x,rz.y,rz.z*sign(worldN.z))*rw.z);normal=normalize(mix(normal,mat3(viewMatrix)*rn,smoothstep(.4,2.8,worldP.y)*.38));`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
roughnessFactor=mix(roughnessFactor,.40,vWet*.7);`,
        );
    };
    const terrain = new T.Mesh(terrainGeo, terrainMat);
    terrain.receiveShadow = true;
    terrain.castShadow = true;
    scene.add(terrain);
    const rimMat = new T.MeshStandardMaterial({ color: 0x413c32, roughness: 0.95 });
    const platform = new T.Mesh(new T.BoxGeometry(worldWidth, 3, worldDepth), rimMat);
    platform.position.y = -1.7;
    platform.receiveShadow = true;
    scene.add(platform);
    const exteriorShape = new T.Shape();
    exteriorShape.moveTo(-1100, -1100);
    exteriorShape.lineTo(1100, -1100);
    exteriorShape.lineTo(1100, 1100);
    exteriorShape.lineTo(-1100, 1100);
    exteriorShape.closePath();
    const hole = new T.Path();
    hole.moveTo(-worldWidth / 2, -worldDepth / 2);
    hole.lineTo(-worldWidth / 2, worldDepth / 2);
    hole.lineTo(worldWidth / 2, worldDepth / 2);
    hole.lineTo(worldWidth / 2, -worldDepth / 2);
    hole.closePath();
    exteriorShape.holes.push(hole);
    const exteriorGeo = new T.ShapeGeometry(exteriorShape);
    const euv = exteriorGeo.attributes.uv,
      ep = exteriorGeo.attributes.position;
    for (let k = 0; k < euv.count; k++) euv.setXY(k, ep.getX(k) / worldWidth, ep.getY(k) / worldDepth);
    const outerGround = new T.Mesh(
      exteriorGeo,
      new T.MeshStandardMaterial({
        color: 0x787768,
        roughness: 1,
        map: groundTex,
        transparent: true,
        opacity: 1,
      }),
    );
    outerGround.rotation.x = -Math.PI / 2;
    outerGround.position.y = 0;
    outerGround.receiveShadow = true;
    scene.add(outerGround);

    function surfaceHeight(x, z) {
      const nx = m * 12,
        nz = n * 12,
        xx = (x / worldWidth + 0.5) * nx,
        zz = (z / worldDepth + 0.5) * nz,
        i = Math.max(0, Math.min(nx - 1, Math.floor(xx))),
        j = Math.max(0, Math.min(nz - 1, Math.floor(zz))),
        fx = xx - i,
        fz = zz - j,
        a = j * (nx + 1) + i,
        b = a + nx + 1,
        d = a + 1,
        c = b + 1;
      return fx + fz <= 1
        ? origY[a] * (1 - fx - fz) + origY[b] * fz + origY[d] * fx
        : origY[b] * (1 - fx) + origY[d] * (1 - fz) + origY[c] * (fx + fz - 1);
    }
    const stoneProps = [];
    for (let k = 0; k < grid.length; k++)
      if (grid[k] === 201) {
        const cp = cellPos(k);
        for (let q = 0; q < 4; q++) {
          const x = cp.x + (hash(k, q + 400) - 0.5) * CX * 0.76,
            z = cp.z + (hash(k, q + 430) - 0.5) * CZ * 0.76,
            y = surfaceHeight(x, z);
          if (
            y < 0.35 ||
            Math.hypot(
              surfaceHeight(x + 0.3, z) - surfaceHeight(x - 0.3, z),
              surfaceHeight(x, z + 0.3) - surfaceHeight(x, z - 0.3),
            ) /
              0.6 >
              1.0
          )
            continue;
          stoneProps.push({ x, y, z, s: 0.25 + hash(k, q + 450) * 0.7, r: hash(k, q + 460) * 6 });
        }
      }
    const boulderGeo = new T.IcosahedronGeometry(1, 1),
      boulderMat = new T.MeshStandardMaterial({
        map: rockD,
        normalMap: rockN,
        roughnessMap: rockR,
        color: 0x999b96,
        roughness: 1,
        normalScale: new T.Vector2(0.5, 0.5),
      }),
      boulders = new T.InstancedMesh(boulderGeo, boulderMat, stoneProps.length);
    const bd = new T.Object3D();
    stoneProps.forEach((b, k) => {
      bd.position.set(b.x, b.y - b.s * 0.34, b.z);
      bd.rotation.set(b.r * 0.3, b.r, b.r * 0.2);
      bd.scale.set(b.s * 1.3, b.s * 0.55, b.s);
      bd.updateMatrix();
      boulders.setMatrixAt(k, bd.matrix);
    });
    boulders.castShadow = boulders.receiveShadow = true;
    scene.add(boulders);
    const waterGroup = new T.Group(),
      reedGroup = new T.Group(),
      props = new T.Group();
    scene.add(waterGroup, reedGroup, props);
    // Restrict water geometry to organic basins; no translucent board-sized plane.
    const wp = [],
      wc = [],
      wn = [],
      wu = [],
      waterY = -0.035,
      wetRes = 600,
      dxw = worldWidth / wetRes,
      dzw = worldDepth / wetRes;
    function waterVertex(x, z) {
      const wet = wetness(x, z),
        alpha = smooth((wet - 0.39) / 0.24) * 0.86;
      return { x, z, wet, alpha };
    }
    function waterTriangle(a, b, c) {
      if (Math.max(a.alpha, b.alpha, c.alpha) < 0.01) return;
      for (const q of [a, b, c]) {
        wp.push(q.x, waterY, q.z);
        wn.push(0, 1, 0);
        wu.push(q.x * 0.45, q.z * 0.45);
        let tint = 0.72 + 0.24 * landform.fbm(q.x * 0.05, q.z * 0.05);
        wc.push(0.34 * tint, 0.39 * tint, 0.29 * tint, q.alpha);
      }
    }
    let waterRow = Array.from({ length: wetRes + 1 }, (_, j) =>
      waterVertex(-worldWidth / 2 + j * dxw, -worldDepth / 2),
    );
    for (let i = 0; i < wetRes; i++) {
      const next = Array.from({ length: wetRes + 1 }, (_, j) =>
        waterVertex(-worldWidth / 2 + j * dxw, -worldDepth / 2 + (i + 1) * dzw),
      );
      for (let j = 0; j < wetRes; j++) {
        waterTriangle(waterRow[j], next[j], waterRow[j + 1]);
        waterTriangle(waterRow[j + 1], next[j], next[j + 1]);
      }
      waterRow = next;
    }
    const waterNormalData = new Uint8Array(256 * 256 * 4);
    for (let j = 0; j < 256; j++)
      for (let i = 0; i < 256; i++) {
        const x = i * 0.13,
          z = j * 0.13,
          eps = 0.07,
          gx = (landform.fbm(x + eps, z) - landform.fbm(x - eps, z)) * 0.65,
          gz = (landform.fbm(x, z + eps) - landform.fbm(x, z - eps)) * 0.65,
          k = (j * 256 + i) * 4;
        waterNormalData.set([128 + gx * 127, 128 + gz * 127, 253, 255], k);
      }
    const waterNormal = new T.DataTexture(waterNormalData, 256, 256);
    waterNormal.wrapS = waterNormal.wrapT = T.RepeatWrapping;
    waterNormal.needsUpdate = true;
    waterNormal.minFilter = waterNormal.magFilter = T.LinearFilter;
    const waterGeo = new T.BufferGeometry();
    waterGeo.setAttribute('position', new T.Float32BufferAttribute(wp, 3));
    waterGeo.setAttribute('normal', new T.Float32BufferAttribute(wn, 3));
    waterGeo.setAttribute('uv', new T.Float32BufferAttribute(wu, 2));
    waterGeo.setAttribute('color', new T.Float32BufferAttribute(wc, 4));
    const waterMat = new T.MeshPhysicalMaterial({
      color: 0x48513c,
      vertexColors: true,
      roughness: 0.3,
      metalness: 0,
      ior: 1.333,
      reflectivity: 0.4,
      clearcoat: 0.22,
      clearcoatRoughness: 0.3,
      normalMap: waterNormal,
      normalScale: new T.Vector2(0.38, 0.38),
      transparent: true,
      opacity: 0.91,
      depthWrite: false,
    });
    const waterMesh = new T.Mesh(waterGeo, waterMat);
    waterMesh.receiveShadow = true;
    waterGroup.add(waterMesh);
    const stems = [],
      leaves = [],
      lilies = [];
    for (let k = 0; k < grid.length; k++)
      if (grid[k] === 204 || (grid[k] >= 150 && grid[k] < 200)) {
        const cp = cellPos(k),
          density = 220 + Math.floor(hash(k, 80) * 480);
        for (let q = 0; q < density; q++) {
          const x = cp.x + (hash(k, q + 91) - 0.5) * CX * 1.15,
            z = cp.z + (hash(k, q + 181) - 0.5) * CZ * 1.15,
            wet = wetness(x, z);
          if (wet < 0.25 || wet > 0.86) continue;
          const y = terrainHeight(x, z),
            height = 0.4 + hash(k, q + 300) * 1.25,
            angle = hash(k, q + 700) * 6.28;
          stems.push({ x, y, z, h: height, r: angle, lean: (hash(k, q + 900) - 0.5) * 0.2 });
          for (let l = 0; l < 3; l++)
            leaves.push({
              x,
              y: y + height * 0.26,
              z,
              h: height * (0.45 + hash(k, q + l + 500) * 0.3),
              r: angle + l * 2.1,
            });
        }
        if (hash(k, 850) > 0.63)
          for (let q = 0; q < 12; q++) {
            const x = cp.x + (hash(k, q + 650) - 0.5) * CX * 0.8,
              z = cp.z + (hash(k, q + 750) - 0.5) * CZ * 0.8;
            if (wetness(x, z) > 0.72)
              lilies.push({ x, z, r: hash(k, q + 950) * 6.28, s: 0.1 + hash(k, q + 999) * 0.2 });
          }
      }
    const dummy = new T.Object3D(),
      stemMesh = new T.InstancedMesh(
        new T.CylinderGeometry(0.018, 0.032, 1, 5),
        new T.MeshStandardMaterial({ color: 0x716b43, roughness: 0.96 }),
        stems.length,
      ),
      leafMesh = new T.InstancedMesh(
        new T.PlaneGeometry(0.13, 1).translate(0.04, 0.5, 0),
        new T.MeshStandardMaterial({ color: 0x596742, roughness: 0.91, side: T.DoubleSide }),
        leaves.length,
      );
    stems.forEach((p, k) => {
      dummy.position.set(p.x, p.y + p.h / 2, p.z);
      dummy.rotation.set(0, p.r, p.lean);
      dummy.scale.set(1, p.h, 1);
      dummy.updateMatrix();
      stemMesh.setMatrixAt(k, dummy.matrix);
      stemMesh.setColorAt(
        k,
        new T.Color().setHSL(0.13 + hash(k, 12) * 0.11, 0.19, 0.23 + hash(k, 14) * 0.12),
      );
    });
    leaves.forEach((p, k) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0.12, p.r, 0.3 + hash(k, 10) * 0.4);
      dummy.scale.set(0.7 + hash(k, 7) * 0.7, p.h, 1);
      dummy.updateMatrix();
      leafMesh.setMatrixAt(k, dummy.matrix);
    });
    stemMesh.castShadow = true;
    stemMesh.receiveShadow = leafMesh.receiveShadow = true;
    reedGroup.add(stemMesh, leafMesh);
    const lilyMesh = new T.InstancedMesh(
      new T.CircleGeometry(1, 9, 0.12, Math.PI * 1.85),
      new T.MeshStandardMaterial({ color: 0x536c3d, roughness: 0.78, side: T.DoubleSide }),
      lilies.length,
    );
    lilies.forEach((p, k) => {
      dummy.position.set(p.x, waterY + 0.012, p.z);
      dummy.rotation.set(-Math.PI / 2, 0, p.r);
      dummy.scale.set(p.s, p.s * 0.8, 1);
      dummy.updateMatrix();
      lilyMesh.setMatrixAt(k, dummy.matrix);
    });
    lilyMesh.receiveShadow = true;
    waterGroup.add(lilyMesh);

    const gltfLoader = tracked(new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder));
    const [heroGL, midGL, lowGL] = await Promise.all([
      ...['knight-hero.glb', 'knight-lod.glb', 'knight-crowd.glb'].map(async (name) =>
        gltfLoader.loadAsync(await assetLoader.modelURL(name)),
      ),
    ]);
    function recolor(original, owner, stone = false) {
      if (!original) return null;
      const img = original.image,
        c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const im = ctx.getImageData(0, 0, c.width, c.height),
        a = im.data,
        target = new T.Color(palette[owner] || '#777777');
      // Match cloth/roofs to native faction colours while keeping metallic trim and skin.
      for (let p = 0; p < a.length; p += 4) {
        const r = a[p],
          g = a[p + 1],
          b = a[p + 2],
          mx = Math.max(r, g, b),
          mn = Math.min(r, g, b);
        const mask = stone ? mx - mn > 35 && mx > 50 : b > r * 1.17 && b > g * 1.12 && b > 30;
        if (mask) {
          const v = mx / 255;
          a[p] = (30 + target.r * 145) * v;
          a[p + 1] = (30 + target.g * 145) * v;
          a[p + 2] = (30 + target.b * 145) * v;
        } else if (stone) {
          const noise = 0.6 + hash(p, 3) * 0.15;
          const gray = (r + g + b) / 3;
          a[p] = gray * noise * 1.06;
          a[p + 1] = gray * noise;
          a[p + 2] = gray * noise * 0.88;
        }
      }
      ctx.putImageData(im, 0, 0);
      const out = new T.CanvasTexture(c);
      out.colorSpace = T.SRGBColorSpace;
      out.flipY = original.flipY;
      out.anisotropy = 4;
      return out;
    }
    const unitMaps = new Map(),
      castleMaps = new Map();
    function factionMap(map, owner, stone = false) {
      const cache = stone ? castleMaps : unitMaps,
        key = map.uuid + '-' + owner;
      if (!cache.has(key)) cache.set(key, recolor(map, owner, stone));
      return cache.get(key);
    }
    const bronze = new T.MeshStandardMaterial({ color: 0xb39152, roughness: 0.45, metalness: 0.55 });
    const buildingMats = await materials(texLoader);
    const buildings = [];
    function castle(index, owner, main = false) {
      const result = fortress(buildingMats, true, !main);
      result.root.position.copy(cellPos(index));
      scene.add(result.root);
      result.update(1);
      const entry = { ...result, index, owner, main };
      buildings.push(entry);
      return entry;
    }
    let mainCastle;
    for (let k = 0; k < grid.length; k++)
      if (grid[k] >= 100 && grid[k] < 150) {
        const c = castle(k, grid[k] % 50, k === focusCell);
        if (k === focusCell) mainCastle = c;
      }
    const commandPost = fortress(buildingMats, false),
      post = commandPost.root;
    post.position.copy(focus);
    scene.add(post);
    const foundation = new T.Group();
    scene.add(foundation);
    const outline = new T.Group();
    scene.add(outline);
    const flags = [];
    function flag(x, z, owner, scale = 1) {
      const g = new T.Group();
      g.position.set(x, terrainHeight(x, z), z);
      const pole = new T.Mesh(new T.CylinderGeometry(0.045, 0.055, 5.2, 7), bronze);
      pole.position.y = 2.6;
      g.add(pole);
      const geo = new T.PlaneGeometry(1.65, 1.0, 16, 9);
      geo.translate(0.825, -0.5, 0);
      const cloth = new T.Mesh(
        geo,
        new T.MeshStandardMaterial({ color: palette[owner], roughness: 0.85, side: T.DoubleSide }),
      );
      cloth.position.y = 4.95;
      g.add(cloth);
      g.scale.setScalar(scale);
      scene.add(g);
      flags.push({ g, cloth, phase: hash(x, z) * 6 });
      return g;
    }
    flag(focus.x - 5, focus.z + 5, 3, 1.3);
    for (let k = 0; k < grid.length; k++)
      if (grid[k] >= 100 && grid[k] < 150) {
        const v = cellPos(k);
        if (k !== focusCell) flag(v.x - 4, v.z + 4, grid[k] % 50, 0.9);
      }

    const fieldArmy = new T.Group(),
      marchArmy = new T.Group();
    scene.add(fieldArmy, marchArmy);
    const soldiers = [];
    function soldier(parent, x, z, owner, quality = 'low', lead = false, seed = 0) {
      const gl = quality === 'hero' ? heroGL : quality === 'mid' ? midGL : lowGL,
        pivot = new T.Group(),
        model = clone(gl.scene);
      // Exported rigs share the original 2.102 m bind-pose height. A freshly cloned
      // SkinnedMesh has stale bone world matrices; measuring it here yields 1/100 scale.
      const variation = 0.97 + hash(seed, 1) * 0.06,
        scale = (1.95 / 2.1020191168288993) * variation;
      model.scale.setScalar(scale);
      model.position.y = 0;
      pivot.add(model);
      pivot.position.set(x, terrainHeight(x, z), z);
      pivot.rotation.y = Math.PI + (hash(seed, 2) - 0.5) * 0.12;
      parent.add(pivot);
      model.traverse((o) => {
        if (o.isMesh) {
          o.material = o.material.clone();
          if (o.material.map) o.material.map = factionMap(o.material.map, owner);
          o.material.roughness = 0.9;
          o.material.metalness = 0.2;
          o.castShadow = quality !== 'low';
          o.receiveShadow = quality !== 'low';
          o.frustumCulled = quality === 'low';
          if (o.isSkinnedMesh) o.boundingSphere = new T.Sphere(new T.Vector3(0, 100, 0), 165);
        }
      });
      const mixer = new T.AnimationMixer(model),
        walk = gl.animations.find((a) => a.name === 'walk');
      mixer.clipAction(walk).play();
      const entry = {
        pivot,
        model,
        mixer,
        gl,
        x,
        z,
        baseY: pivot.position.y,
        phase: hash(seed, 3),
        speed: 0.85 + hash(seed, 4) * 0.03,
        variation,
        yaw: Math.PI + (hash(seed, 2) - 0.5) * 0.07,
        lead,
        parent,
        owner,
        fxParent: scene,
      };
      if (parent === marchArmy) entry.motion = new Motion(entry, motionProfile, terrainHeight);
      soldiers.push(entry);
      return entry;
    }
    let leader = soldier(marchArmy, heroBase.x, heroBase.z, 3, 'hero', true, 1001);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 5; c++) {
        if (r === 0 && c === 2) continue;
        const seed = r * 5 + c + 1600,
          x = heroBase.x + (c - 2) * 1.48 + (hash(seed, 1) - 0.5) * 0.36,
          z = heroBase.z + r * 2.2 + (hash(seed, 2) - 0.5) * 0.45;
        soldier(marchArmy, x, z, 3, r === 0 ? 'hero' : 'mid', false, seed);
      }
    for (let k = 0; k < grid.length; k++) {
      const code = grid[k],
        owner = code < 200 ? code % 50 : 0;
      if (owner <= 0 || owner > 16 || code === 201) continue;
      const cp = cellPos(k);
      if (cp.distanceTo(focus) < 22) continue;
      const count = 1;
      for (let v = 0; v < count; v++) {
        const x = cp.x + (hash(k, v + 1) - 0.5) * 8,
          z = cp.z + (hash(k, v + 4) - 0.5) * 7;
        soldier(fieldArmy, x, z, owner, 'low', false, k * 3 + v);
      }
    }

    const dustTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const ctx = c.getContext('2d'),
        g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, 'rgba(196,172,132,.2)');
      g.addColorStop(1, 'rgba(196,172,132,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      return new T.CanvasTexture(c);
    })();
    const dust = [];
    for (let k = 0; k < 18; k++) {
      const sp = new T.Sprite(
        new T.SpriteMaterial({ map: dustTex, transparent: true, depthWrite: false, opacity: 0.18 }),
      );
      sp.position.set(
        focus.x + (hash(k, 2) - 0.5) * 55,
        1 + hash(k, 3) * 4,
        focus.z + (hash(k, 4) - 0.5) * 45,
      );
      sp.scale.set(14, 9, 1);
      scene.add(sp);
      dust.push({ sp, x: sp.position.x, z: sp.position.z, phase: hash(k, 9) * 7 });
    }

    const mapTex = own(new T.Texture()); // Native handoff is composited once by the Canvas director.
    const rt = own(
      new T.WebGLRenderTarget(W, H, { type: T.HalfFloatType, depthTexture: new T.DepthTexture(W, H) }),
    );
    rt.samples = 2;
    rt.texture.colorSpace = T.LinearSRGBColorSpace;
    const postScene = own(new T.Scene()),
      postCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const postMat = new T.ShaderMaterial({
      toneMapped: false,
      uniforms: {
        colorTex: { value: rt.texture },
        depthTex: { value: rt.depthTexture },
        nativeTex: { value: mapTex },
        nativeMix: { value: 0 },
        focusDistance: { value: 20 },
        blurStrength: { value: 0 },
        nearP: { value: 0.1 },
        farP: { value: 2000 },
        isOrtho: { value: 0 },
        exposure: { value: 0.98 },
        resolution: { value: new T.Vector2(W, H) },
      },
      vertexShader: 'varying vec2 uvV;void main(){uvV=uv;gl_Position=vec4(position,1.);}',
      fragmentShader: `
 uniform sampler2D colorTex,depthTex,nativeTex;uniform float nativeMix,focusDistance,blurStrength,nearP,farP,isOrtho,exposure;uniform vec2 resolution;varying vec2 uvV;
 vec3 aces(vec3 c){return clamp((c*(2.51*c+.03))/(c*(2.43*c+.59)+.14),0.,1.);}
 vec3 gammaOut(vec3 c){return mix(12.92*c,1.055*pow(max(c,vec3(0.)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
 float noise(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}float mist(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(noise(i),noise(i+vec2(1,0)),f.x),mix(noise(i+vec2(0,1)),noise(i+vec2(1,1)),f.x),f.y);}
 void main(){float depth=texture2D(depthTex,uvV).r;float z=mix((nearP*farP)/(farP-(farP-nearP)*depth),nearP+(farP-nearP)*depth,isOrtho);float r=clamp(abs(z-focusDistance)*blurStrength,0.,5.);vec3 c;
 if(r>.1){c=vec3(0.);for(int i=0;i<8;i++){float a=float(i)*2.39996;float rr=sqrt((float(i)+.5)/8.)*r;vec2 off=vec2(cos(a),sin(a))*rr/resolution;c+=texture2D(colorTex,uvV+off).rgb;}c/=8.;}else c=texture2D(colorTex,uvV).rgb;
 c=gammaOut(aces(c*exposure));float lum=dot(c,vec3(.2126,.7152,.0722));c=mix(vec3(lum),c,.88);c*=vec3(1.025,1.005,.965);
 if(nativeMix>0.){vec2 q=(uvV-vec2(.25390625,.083333333))/vec2(.4921875,.833333333);vec3 n=vec3(6.,13.,20.)/255.;if(q.x>=0.&&q.x<=1.&&q.y>=0.&&q.y<=1.)n=texture2D(nativeTex,q).rgb;c=mix(c,n,nativeMix);}
 gl_FragColor=vec4(c,1.);}`,
    });
    postScene.add(new T.Mesh(new T.PlaneGeometry(2, 2), postMat));
    function resize(width, height) {
      if (renderer.domElement.width === width && renderer.domElement.height === height) return false;
      renderer.setSize(width, height, false);
      rt.setSize(width, height);
      postMat.uniforms.resolution.value.set(width, height);
      return true;
    }
    function resizeToDisplay() {
      if (!nativeResolution) return false;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      const dpr = globalThis.devicePixelRatio || 1;
      return resize(Math.max(1, Math.round(rect.width * dpr)), Math.max(1, Math.round(rect.height * dpr)));
    }
    let flatState = -1;
    function flatten(amount) {
      if (Math.abs(amount - flatState) < 0.00001) return;
      flatState = amount;
      for (let k = 0; k < pos.count; k++) pos.setY(k, origY[k] * (1 - amount));
      pos.needsUpdate = true;
      terrainGeo.computeVertexNormals();
      for (const b of buildings) b.root.scale.y = 1 - amount * 0.995;
      waterGroup.scale.y = 1 - amount * 0.9;
      reedGroup.scale.y = 1 - amount * 0.995;
    }
    function orthoView(height) {
      ortho.left = (-height * W) / H / 2;
      ortho.right = (height * W) / H / 2;
      ortho.top = height / 2;
      ortho.bottom = -height / 2;
      ortho.updateProjectionMatrix();
    }
    const fxTexture = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const x = c.getContext('2d'),
        g = x.createRadialGradient(32, 32, 0, 32, 32, 31);
      g.addColorStop(0, 'rgba(223,206,171,.7)');
      g.addColorStop(1, 'rgba(223,206,171,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, 64, 64);
      return new T.CanvasTexture(c);
    })();
    const impactFX = [];
    for (let k = 0; k < 64; k++) {
      const s = new T.Sprite(
        new T.SpriteMaterial({ map: fxTexture, depthWrite: false, transparent: true, opacity: 0 }),
      );
      scene.add(s);
      impactFX.push(s);
    }
    const stepFX = [];
    for (let k = 0; k < 36; k++) {
      const s = new T.Sprite(
        new T.SpriteMaterial({ map: fxTexture, depthWrite: false, transparent: true, opacity: 0 }),
      );
      scene.add(s);
      stepFX.push(s);
    }
    const sparkGeo = new T.BufferGeometry();
    sparkGeo.setAttribute('position', new T.BufferAttribute(new Float32Array(48 * 3), 3));
    const sparks = new T.Points(
      sparkGeo,
      new T.PointsMaterial({ color: 0xffd88c, size: 0.06, transparent: true, depthWrite: false }),
    );
    scene.add(sparks);
    const hammerLight = new T.PointLight(0xffd797, 0, 10, 2);
    scene.add(hammerLight);
    function constructionEffects(t, duration, progress) {
      const stroke = Math.floor(t * 2),
        age = t - stroke * 0.5,
        active = t > 0.45 && t < duration - 0.3;
      const side = stroke % 4,
        px = focus.x + (side === 0 ? -2.7 : side === 1 ? 2.7 : (hash(stroke, 1) - 0.5) * 5.5),
        pz = focus.z + (side === 2 ? -2.4 : side === 3 ? 2.4 : (hash(stroke, 2) - 0.5) * 5.5),
        py = 0.6 + progress * 5;
      for (let k = 0; k < impactFX.length; k++) {
        const sp = impactFX[k],
          a = (age + (k % 4) * 0.5) * 0.9;
        sp.visible = active && a < 1.2;
        sp.position.set(
          px + (hash(k, stroke) - 0.5) * a * 2,
          py + a * (0.5 + hash(k, 2)),
          pz + (hash(k, 3) - 0.5) * a * 2,
        );
        sp.scale.setScalar(0.3 + a * 1.8);
        sp.material.opacity = Math.max(0, 0.3 * (1 - a));
      }
      const a = sparkGeo.attributes.position;
      for (let k = 0; k < a.count; k++) {
        const vx = (hash(k, stroke + 6) - 0.5) * 2,
          vy = hash(k, 4) * 2;
        a.setXYZ(k, px + vx * age, py + vy * age - 4.9 * age * age, pz + (hash(k, 8) - 0.5) * age * 1.7);
      }
      a.needsUpdate = true;
      sparks.visible = active && age < 0.22;
      sparks.material.opacity = Math.max(0, 1 - age / 0.22);
      hammerLight.position.set(px, py + 0.3, pz);
      hammerLight.intensity = active ? 7 * Math.exp(-age * 35) : 0;
    }
    function renderAt(name, t, duration) {
      renderer.info.reset();
      const u = T.MathUtils.clamp(t / duration, 0, 1);
      let active = camera,
        nativeMix = 0;
      const isBuild = name === 'post' || name === 'upgrade',
        isAscend = name === 'ascend',
        isCharge = name === 'charge';
      post.visible = false;
      foundation.visible = false;
      mainCastle.root.visible = true;
      mainCastle.root.scale.set(1, 1, 1);
      mainCastle.update(1);
      marchArmy.visible = !isBuild && name !== 'resolve';
      fieldArmy.visible = isAscend && u > 0.14;
      outline.visible = false;
      impactFX.forEach((s) => (s.visible = false));
      stepFX.forEach((s) => (s.visible = false));
      sparks.visible = false;
      hammerLight.intensity = 0;
      scene.fog.density = 0.0016;
      outerGround.visible = true;
      outerGround.material.opacity = isAscend ? 1 - smooth((u - 0.62) / 0.15) : 1;
      if (isBuild) {
        const buildP = Math.min(1, Math.floor(t * 2) / (duration * 2 - 1));
        post.visible = name === 'post' || u < 0.25;
        commandPost.update(name === 'post' ? buildP : 1);
        mainCastle.root.visible = name === 'upgrade';
        if (name === 'upgrade') mainCastle.update(buildP);
        const angle = Math.PI - 0.25 + u * 0.45,
          r = name === 'post' ? 16 : 24;
        camera.position.set(focus.x + Math.sin(angle) * r, 7 + u * 1.4, focus.z + Math.cos(angle) * r);
        camera.lookAt(focus.x, name === 'post' ? 2.5 : 4, focus.z);
        camera.fov = 44;
        constructionEffects(t, duration, buildP);
      } else if (name === 'march' || name === 'prologue') {
        mainCastle.root.visible = false;
        camera.position.set(heroBase.x + 2.8, 2.0, heroBase.z - 15 - t * 1.15);
        camera.lookAt(heroBase.x, 1.0, heroBase.z - t * 1.24);
        camera.fov = 43;
      } else if (isCharge) {
        mainCastle.root.visible = false;
        camera.position.set(heroBase.x + 10, 2.0, heroBase.z - 9 - t * 3.75);
        camera.lookAt(heroBase.x, 1.0, heroBase.z - t * 3.85);
        camera.fov = 47;
      } else if (name === 'wetland') {
        const k = grid.findIndex((v, i) => v === 204 && cellPos(i).distanceTo(focus) < 70);
        const cp = cellPos(k);
        marchArmy.visible = fieldArmy.visible = false;
        camera.position.copy(cp).add(new T.Vector3(8, 3.1, 8));
        camera.lookAt(cp.x, -0.05, cp.z);
        camera.fov = 48;
      } else if (name === 'leader' || isAscend) {
        active = ortho;
        const a = isAscend ? smooth(Math.min(1, u / 0.8)) : 0,
          pan = isAscend ? smooth((u - 0.22) / 0.58) : 0,
          height = 9 * Math.pow(360 / 9, a),
          target = heroBase
            .clone()
            .add(new T.Vector3(0, 1, 0))
            .lerp(new T.Vector3(0, 0, 0), (height - 9) / 351);
        const az = lerp(Math.atan2(3, -12), 0, pan),
          e0 = Math.atan2(3, Math.hypot(3, 12)),
          elev = isAscend
            ? u < 0.22
              ? lerp(e0, 1.25, smooth(u / 0.22))
              : lerp(1.25, Math.PI / 2, smooth((u - 0.22) / 0.58))
            : e0,
          r = lerp(Math.sqrt(162), 245, a);
        ortho.position
          .copy(target)
          .add(
            new T.Vector3(
              Math.sin(az) * Math.cos(elev) * r,
              Math.sin(elev) * r,
              Math.cos(az) * Math.cos(elev) * r,
            ),
          );
        ortho.up.set(0, 1 - pan, -pan).normalize();
        ortho.lookAt(target);
        orthoView(height);
        if (isAscend) {
          nativeMix = 0;
          scene.fog.density = 0.0016 * (1 - a);
        }
      } else if (name === 'resolve') {
        const a = Math.PI - 0.2 + u * 0.35;
        camera.position.set(focus.x + Math.sin(a) * 24, 10, focus.z + Math.cos(a) * 24);
        camera.lookAt(focus.x, 4.7, focus.z);
        camera.fov = 43;
      }
      // Mountain relief and cast shadows remain visible throughout the direct ascent.
      let fxIndex = 0;
      for (const tr of soldiers) {
        if (!tr.parent.visible) {
          if (tr.motion) tr.motion.shadows.forEach((s) => (s.visible = false));
          continue;
        }
        if (tr.motion) {
          tr.motion.update(
            name === 'prologue' ? 0 : t,
            name === 'march' || name === 'prologue' ? 'walk' : isCharge ? 'run' : 'idle',
            name === 'leader' && tr.lead,
          );
          for (const c of tr.motion.contacts) {
            if (c.age >= 0 && c.age < 0.32 && fxIndex < stepFX.length) {
              const sp = stepFX[fxIndex++];
              sp.visible = true;
              sp.position.set(
                c.actual[0] + Math.sin(tr.phase * 9) * c.age * 0.35,
                c.ground + 0.07 + c.age * 0.4,
                c.actual[2],
              );
              sp.scale.setScalar(0.14 + c.age * 0.75);
              sp.material.opacity = (1 - c.age / 0.32) * 0.2;
            }
          }
        } else if (!tr.poseReady) {
          tr.mixer.setTime(tr.phase * 0.8);
          tr.pivot.position.y = tr.baseY;
          tr.model.updateMatrixWorld(true);
          tr.poseReady = true;
        }
      }
      waterNormal.offset.set(t * 0.013, t * 0.008);
      for (const f of flags) {
        const p = f.cloth.geometry.attributes.position;
        for (let k = 0; k < p.count; k++) {
          const x = p.getX(k);
          p.setZ(
            k,
            ((Math.sin(x * 3 - t * 3.3 + f.phase) * 0.13 + Math.sin(x * 6 - t * 4.7) * 0.035) * x) / 1.65,
          );
        }
        p.needsUpdate = true;
        f.cloth.geometry.computeVertexNormals();
      }
      for (const d of dust) {
        d.sp.visible = !isAscend || u < 0.65;
        d.sp.position.x = d.x + Math.sin(t * 0.15 + d.phase) * 2;
        d.sp.position.z = d.z + t * 0.1;
        d.sp.material.opacity = 0.1 + 0.025 * Math.sin(t + d.phase);
      }
      const shadowRadius = isAscend
        ? lerp(24, 210, smooth(u / 0.8))
        : isBuild || name === 'resolve'
          ? 22
          : 22;
      const shadowTarget = isAscend
        ? heroBase.clone().lerp(new T.Vector3(), smooth(u / 0.8))
        : isBuild || name === 'resolve'
          ? focus
          : heroBase
              .clone()
              .add(new T.Vector3(0, 0, -(isCharge ? t * 3.8 : name === 'march' ? t * 1.25 : 0)));
      sun.target.position.copy(shadowTarget);
      sun.position.copy(shadowTarget).add(new T.Vector3(-60, 85, -75));
      Object.assign(sun.shadow.camera, {
        left: -shadowRadius,
        right: shadowRadius,
        top: shadowRadius,
        bottom: -shadowRadius,
      });
      sun.shadow.camera.updateProjectionMatrix();
      sun.target.updateMatrixWorld();
      camera.updateProjectionMatrix();
      active.updateMatrixWorld(true);
      postMat.uniforms.nativeMix.value = nativeMix;
      postMat.uniforms.focusDistance.value = active.position.distanceTo(
        heroBase.clone().add(new T.Vector3(0, 1, 0)),
      );
      postMat.uniforms.blurStrength.value = name === 'leader' ? 0.1 : name === 'march' ? 0.1 : 0;
      postMat.uniforms.nearP.value = active.near;
      postMat.uniforms.farP.value = active.far;
      postMat.uniforms.isOrtho.value = active === ortho ? 1 : 0;
      renderer.setRenderTarget(rt);
      renderer.render(scene, active);
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCam);
      return renderer.domElement;
    }

    own({
      dispose() {
        for (const s of soldiers) s.mixer.stopAllAction();
        sun.shadow.map?.dispose();
        for (const t of [...unitMaps.values(), ...castleMaps.values()]) t.dispose();
      },
    });
    check();
    onStatus('正在准备光影与动画…');
    renderAt('march', 0, 8);
    check();
    return {
      renderAt: (...args) => {
        if (disposed) return null;
        if (contextLost) throw new Error('WebGL context lost');
        resizeToDisplay();
        return renderAt(...args);
      },
      canvas: renderer.domElement,
      setVisible(value) {
        renderer.domElement.style.display = value ? 'block' : 'none';
      },
      present(name, time, duration, rect = [0, 0, 1920, 1080]) {
        if (disposed) return null;
        if (contextLost) throw new Error('WebGL context lost');
        const [x, y, w, h] = rect;
        renderer.domElement.style.cssText = `display:block;position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:0;pointer-events:none`;
        resizeToDisplay();
        return renderAt(name, time, duration);
      },
      resize: resizeToDisplay,
      dispose,
      getMetrics: () => ({
        renderer: renderer.info.render,
        memory: renderer.info.memory,
        units: soldiers.length,
        terrainVertices: pos.count,
        landforms: landform.stats,
        waterTriangles: wp.length / 9,
        reedStems: stems.length,
        internalWidth: renderer.domElement.width,
        internalHeight: renderer.domElement.height,
      }),
      getDebug: () => ({ scene, soldiers, buildings }),
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
