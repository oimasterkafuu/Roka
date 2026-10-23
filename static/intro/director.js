import { createReplayBoard, PALETTE, frameIndex } from './replay-board.js';
const W = 1920,
  H = 1080,
  GOLD = '#e2c284',
  WHITE = '#f1eee3',
  MUTED = '#93a4a8',
  BG = '#060d14';
const FONTS = { serif: 'RokaIntroSerif', cn: 'RokaIntroCN', latin: 'RokaIntroLatin', sans: 'RokaIntroSans' };
const CG = new Set(['march', 'post', 'upgrade', 'leader', 'ascend', 'resolve', 'charge']);
export function ease(x) {
  x = Math.max(0, Math.min(1, x));
  return x * x * (3 - 2 * x);
}
function surface(w = W, h = H) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
/** Fixed 1920×1080 composition; CSS scales this single frame as a unit. */
export function createDirector(canvas, { assets = {}, plan, replays, scene } = {}) {
  canvas.width = W;
  canvas.height = H;
  // Keep the output accelerated; offscreen caches use CPU backing so small tile
  // draws and cached-image reads cannot stall behind the shared WebGL queue.
  const layered = typeof scene?.present === 'function';
  const ctx = canvas.getContext('2d', { alpha: layered });
  const boards = new Map(),
    backgrounds = new Map(),
    work = surface(),
    wc = work.getContext('2d', { willReadFrequently: true });
  let lastScene = null,
    endBackground = null,
    disposed = false;
  const vignette = surface(),
    vc = vignette.getContext('2d', { willReadFrequently: true }),
    pixels = vc.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const radius = ((x - W / 2) / (W * 0.88)) ** 2 + ((y - H / 2) / (H * 0.95)) ** 2;
      pixels.data[(y * W + x) * 4 + 3] = Math.floor(Math.min(1, radius) * 55);
    }
  vc.putImageData(pixels, 0, 0);
  const smoke = makeSmoke();
  function text(c, s, x, y, size = 40, color = WHITE, spacing = 3, kind = 'serif', center = false) {
    c.save();
    c.font = `${kind === 'cn' || kind === 'serif' ? 700 : 400} ${size}px ${FONTS[kind]}`;
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    c.fillStyle = color;
    const baseline = y + Math.ceil(size * (kind === 'serif' ? 1.15 : kind === 'cn' ? 1.16 : 0.93));
    if (center) {
      let width = spacing * (s.length - 1);
      for (const ch of s) width += c.measureText(ch).width;
      x -= width / 2;
    }
    for (const ch of s) {
      c.fillText(ch, x, baseline);
      x += c.measureText(ch).width + spacing;
    }
    c.restore();
  }
  function plain(c, s, x, y, size, color = WHITE, kind = 'cn', right = false) {
    c.save();
    c.font = `${kind === 'cn' ? 700 : 400} ${size}px ${FONTS[kind]}`;
    c.fillStyle = color;
    c.textBaseline = 'alphabetic';
    c.textAlign = right ? 'right' : 'left';
    c.fillText(s, x, y + Math.ceil(size * (kind === 'cn' ? 1.16 : 0.93)));
    c.restore();
  }
  function crown(c, x, y, size, color = GOLD) {
    const points = [
      [-0.5, -0.2],
      [-0.34, 0.38],
      [0.34, 0.38],
      [0.5, -0.2],
      [0.22, 0.02],
      [0, -0.47],
      [-0.22, 0.02],
    ];
    c.fillStyle = color;
    c.beginPath();
    points.forEach(([a, b], i) =>
      i ? c.lineTo(x + a * size, y + b * size) : c.moveTo(x + a * size, y + b * size),
    );
    c.closePath();
    c.fill();
    c.strokeStyle = color;
    c.lineWidth = Math.max(1, Math.floor(size * 0.055));
    c.beginPath();
    c.moveTo(x - size * 0.36, y + size * 0.49);
    c.lineTo(x + size * 0.36, y + size * 0.49);
    c.stroke();
  }
  function background(c, quadrant = 0) {
    if (!backgrounds.has(quadrant)) {
      const bg = surface(),
        b = bg.getContext('2d', { willReadFrequently: true }),
        img = assets.background || assets.boardBackground;
      b.fillStyle = BG;
      b.fillRect(0, 0, W, H);
      if (img) {
        const sw = img.width / 2,
          sh = img.height / 2;
        b.drawImage(img, (quadrant % 2) * sw, Math.floor(quadrant / 2) * sh, sw, sh, 0, 0, W, H);
        b.fillStyle = 'rgba(6,13,20,.83)';
        b.fillRect(0, 0, W, H);
      }
      b.strokeStyle = 'rgba(17,31,38,.72)';
      b.lineWidth = 1;
      for (let i = -12; i < 26; i++) {
        b.beginPath();
        b.moveTo(i * 120, 76);
        b.lineTo(i * 120 - 380, 1004);
        b.stroke();
      }
      b.strokeStyle = 'rgba(15,28,34,.72)';
      for (let k = 0; k < 15; k++) {
        const y = 100 + k * k * 5.4;
        b.beginPath();
        b.moveTo(0, y);
        b.lineTo(W, y);
        b.stroke();
      }
      backgrounds.set(quadrant, bg);
    }
    c.drawImage(backgrounds.get(quadrant), 0, 0);
  }
  function tileIcon(c, name, x, y, size = 70) {
    c.fillStyle = '#e2e0d3';
    c.fillRect(x, y, size, size);
    if (assets[name])
      c.drawImage(
        assets[name],
        x + Math.floor(size * 0.1),
        y + Math.floor(size * 0.1),
        Math.floor(size * 0.8),
        Math.floor(size * 0.8),
      );
  }
  function subtitle(c, title, sub, opacity = 1, y = 817, bottom = 1004) {
    c.save();
    const gradient = c.createLinearGradient(0, 764, 0, 1004);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, `rgba(0,0,0,${(175 / 255) * opacity})`);
    c.fillStyle = gradient;
    c.fillRect(0, 764, W, bottom - 764);
    c.globalAlpha = opacity;
    text(c, title, W / 2, y, 53, WHITE, 4, 'serif', true);
    if (sub) text(c, sub, W / 2, y + 83, 17, GOLD, 3, 'sans', true);
    c.restore();
  }
  function keycard(c, key, title, icon, progress) {
    c.save();
    c.globalAlpha = (235 / 255) * progress;
    c.fillStyle = BG;
    c.beginPath();
    c.roundRect(94, 160, 348, 110, 10);
    c.fill();
    c.strokeStyle = GOLD;
    c.lineWidth = 2;
    c.beginPath();
    c.roundRect(112, 178, 68, 68, 6);
    c.stroke();
    text(c, key, 146, 185, 40, WHITE, 0, 'sans', true);
    c.restore();
    tileIcon(c, icon, 198, 180, 66);
    text(c, title, 286, 190, 27, GOLD, 2, 'cn');
  }
  function chapter(c, num, lines, sub = '') {
    text(c, num, 90, 172, 21, GOLD, 3, 'sans');
    lines.forEach((line, k) => text(c, line, 90, 266 + k * 77, 42, WHITE, 4));
    sub.split('\n').forEach((line, k) => plain(c, line, 92, 495 + k * 34, 20, MUTED));
  }
  function board(id, tick, t) {
    if (!boards.has(id)) {
      const data = replays.sources[id];
      if (!data) throw new Error(`Missing intro replay ${id}`);
      boards.set(id, createReplayBoard(data, assets));
    }
    return boards.get(id).update(tick, t);
  }
  function stats(c, frame, ids = [1, 2], x = 94, y = 690) {
    for (const id of ids) {
      const s = frame.stats.find((a) => a[0] === id);
      if (!s) continue;
      c.fillStyle = PALETTE[id];
      c.fillRect(x, y, 6, 58);
      c.beginPath();
      c.ellipse(x + 32, y + 14, 8, 8, 0, 0, Math.PI * 2);
      c.fill();
      plain(c, `领土 ${s[1]}  ·  兵力 ${s[2]}`, x + 55, y - 1, 22);
      y += 83;
    }
  }
  function mapview(c, id, tick, t, roi = null, box = [590, 125, 1260, 850]) {
    background(c, id === 'sixteen' ? 2 : id === 'wh0Et-JN3Gso' ? 3 : 0);
    const b = board(id, tick, t),
      tr = b.draw(c, roi, box);
    c.strokeStyle = '#726445';
    c.lineWidth = 1;
    c.strokeRect(tr.ox - 1, tr.oy - 1, tr.width + 1, tr.height + 1);
    plain(c, `TICK ${String(tick).padStart(5, '0')}`, tr.ox + tr.width, tr.oy - 31, 17, GOLD, 'sans', true);
    return { b, tr };
  }
  function arrows(c, source, tick, tr) {
    const actions = replays.actions[source] || [];
    const end = frameIndex(actionTicks(source, actions), tick);
    let count = 0;
    const [j0, i0, cols, rows] = tr.roi;
    for (let k = end; k >= 0 && count < 4; k--) {
      const a = actions[k];
      if (a[0] < tick - 2) break;
      if (a[0] > tick) continue;
      count++;
      const [, i, j, ni, nj] = a;
      if (
        i < i0 ||
        i >= i0 + rows ||
        ni < i0 ||
        ni >= i0 + rows ||
        j < j0 ||
        j >= j0 + cols ||
        nj < j0 ||
        nj >= j0 + cols
      )
        continue;
      const ax = tr.ox + (j - j0 + 0.5) * 42 * tr.scale,
        ay = tr.oy + (i - i0 + 0.5) * 40 * tr.scale,
        bx = tr.ox + (nj - j0 + 0.5) * 42 * tr.scale,
        by = tr.oy + (ni - i0 + 0.5) * 40 * tr.scale;
      c.strokeStyle = GOLD;
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
      c.stroke();
      const angle = Math.atan2(by - ay, bx - ax);
      c.fillStyle = GOLD;
      c.beginPath();
      c.moveTo(bx, by);
      c.lineTo(bx - 11 * Math.cos(angle - 0.42), by - 11 * Math.sin(angle - 0.42));
      c.lineTo(bx - 11 * Math.cos(angle + 0.42), by - 11 * Math.sin(angle + 0.42));
      c.closePath();
      c.fill();
    }
  }
  const ticksCache = new Map();
  function actionTicks(id, actions) {
    if (!ticksCache.has(id))
      ticksCache.set(
        id,
        actions.map((a) => a[0]),
      );
    return ticksCache.get(id);
  }
  function nativeScene(c, t, fr, name) {
    const id = fr.source,
      tick = fr.tick;
    if (name === 'native_match' || name === 'expansion') {
      background(c, 0);
      const b = board(id, tick, t);
      c.drawImage(b.canvas, 488, 90, 945, 900);
      if (name === 'native_match') {
        chapter(
          c,
          'READ THE BATTLEFIELD',
          ['以地为势。', '以城为基。'],
          '山脉阻隔，沼泽藏险。\n每一步，都有取舍。',
        );
        [
          ['mountain', '山脉'],
          ['swamp', '沼泽'],
          ['crown', '主城'],
        ].forEach(([key, label], k) => {
          tileIcon(c, key, 1555, 290 + k * 140, 65);
          plain(c, label, 1640, 303 + k * 140, 25);
        });
      } else {
        chapter(
          c,
          'BUILD YOUR EMPIRE',
          ['建造，', '让疆域生长。'],
          '指挥所，连接前线。\n主城，积蓄下一次进攻。',
        );
        stats(c, b.state, [1, 3], 90, 720);
      }
      return;
    }
    const roi =
      name === 'cutoff' || name === 'attack'
        ? [0, 9, 24, 17]
        : name === 'sixteen_close'
          ? plan.sixteenROI
          : null;
    const { b, tr } = mapview(c, id, tick, t, roi);
    if (name === 'cutoff' || name === 'attack') {
      chapter(
        c,
        name === 'cutoff' ? 'BREAK THE LINK' : 'TAKE IT BACK',
        name === 'cutoff' ? ['一线被断，', '大军成孤。'] : ['接回疆域，', '重整兵锋。'],
        name === 'cutoff'
          ? '切断连通 · 孤军减半\n每一个连接，都关乎生死。'
          : '恢复连通 · 重返战场\n让进攻，再一次向前。',
      );
      stats(c, b.state);
      if (name === 'cutoff') {
        let isolated = 0;
        for (const v of b.state.isolated) if (v) isolated++;
        if (isolated) text(c, `${isolated} 格失联`, 92, 596, 28, GOLD, 3, 'cn');
      } else arrows(c, id, tick, tr);
    } else if (name.startsWith('sixteen')) {
      chapter(c, 'SIXTEEN KINGDOMS', ['十六方，', '群雄同局。'], '每一片颜色，\n都有自己的野心。');
      for (let k = 0; k < 16; k++) {
        c.fillStyle = PALETTE[k + 1];
        c.beginPath();
        c.roundRect(95 + (k % 4) * 75, 650 + Math.floor(k / 4) * 63, 42, 42, 3);
        c.fill();
      }
      text(c, '最多 16 人实时对战', 90, 930, 23, GOLD, 2, 'cn');
    } else {
      if (name === 'crisis')
        chapter(c, 'WHEN ALL SEEMS LOST', ['当胜负，', '几乎写定。'], '兵力落后，\n并不意味着故事结束。');
      else if (name === 'comeback')
        chapter(
          c,
          'CHANGE THE STORY',
          ['你仍有，', '改写它的一步。'],
          '集结、调度、反击。\n让判断，成为真正的优势。',
        );
      else
        chapter(
          c,
          'RECLAIM YOUR WORLD',
          ['把失去的，', '再夺回来。'],
          '从困局中站稳，\n把疆域重新握在手中。',
        );
      stats(c, b.state);
      if (name !== 'crisis') arrows(c, id, tick, tr);
    }
  }
  function cg(c, name, local, duration) {
    const frame = layered ? scene.present(name, local, duration) : scene?.renderAt(name, local, duration);
    if (frame) {
      if (!layered) c.drawImage(frame, 0, 0, W, H);
      lastScene = frame;
    } else background(c, 1);
  }
  function upgradeSmoke(c, local) {
    const strength = ease((local - 0.75) / 0.6) * ease((3.1 - local) / 0.65);
    if (!strength) return;
    const age = Math.max(0, local - 0.75);
    c.save();
    c.globalAlpha = strength * 0.93;
    for (let k = 0; k < 20; k++) {
      const size = Math.floor(360 + (k % 4) * 63 + age * 32),
        x = 960 + ((k % 5) - 2) * 128 + Math.sin(k * 2.1 + age * 0.6) * 32,
        y = 533 + (Math.floor(k / 5) - 1.5) * 112 - age * (15 + (k % 3) * 9);
      c.drawImage(smoke, Math.floor(x - size / 2), Math.floor(y - size / 2), size, size);
    }
    c.restore();
  }
  function renderAt(time) {
    if (disposed) return;
    const t = Math.max(0, Math.min(plan.duration - 1 / plan.fps, time));
    const fr = plan.frames[Math.min(plan.frames.length - 1, Math.floor(t * plan.fps + 1e-7))];
    const shot = plan.shots[fr.shot],
      name = shot.name,
      local = t - shot.start,
      duration = shot.end - shot.start,
      u = local / duration;
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    scene?.setVisible?.(false);
    if (layered && CG.has(name)) ctx.clearRect(0, 0, W, H);
    else {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, W, H);
    }
    let tag = '概念战场 · 视觉演绎';
    if (name === 'prologue') {
      background(ctx);
      const r = 85 + ease(u) * 9,
        cx = W / 2,
        cy = 370,
        points = [
          [cx - r, cy - r],
          [cx + r, cy - r],
          [cx + r, cy + r],
          [cx - r, cy + r],
          [cx - r, cy - r],
        ];
      ctx.strokeStyle = GOLD;
      ctx.lineWidth = 3;
      for (let i = 0; i < 4; i++) {
        const v = Math.max(0, Math.min(1, local * 2 - i)),
          a = points[i],
          b = points[i + 1];
        ctx.beginPath();
        ctx.moveTo(...a);
        ctx.lineTo(a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v);
        ctx.stroke();
      }
      if (local > 2) {
        const f = ease((local - 2) / 0.35);
        crown(ctx, cx, cy, 80, `rgb(${Math.floor(226 * f)},${Math.floor(194 * f)},${Math.floor(132 * f)})`);
      }
      text(ctx, '帝国，始于一格。', W / 2, 590, 66, WHITE, 7, 'serif', true);
      text(ctx, 'ONE TILE. AN ENTIRE EMPIRE.', W / 2, 710, 18, GOLD, 5, 'sans', true);
    } else if (CG.has(name)) {
      cg(ctx, name, local, duration);
      if (name === 'march')
        subtitle(ctx, '千军万马，听你号令。', 'AN EMPIRE AT YOUR COMMAND', ease(local / 0.6));
      if (name === 'post') {
        keycard(ctx, 'X', '指挥所', 'city', ease(local / 0.45));
        subtitle(ctx, '从平地，筑起指挥所。', 'BUILD THE FOUNDATION', ease(local / 0.5));
      }
      if (name === 'upgrade') {
        upgradeSmoke(ctx, local);
        keycard(ctx, 'C', '主城', 'crown', ease(local / 0.45));
        subtitle(ctx, '让一座城，成为新的起点。', 'RAISE A NEW STRONGHOLD', ease(local / 0.5));
      }
      if (name === 'leader') subtitle(ctx, '集结，只为下一击。', 'READY FOR YOUR COMMAND', ease(local / 0.4));
      if (name === 'ascend' && local < 8.5)
        subtitle(
          ctx,
          '山川为界，寸土必争。',
          'EVERY TILE MATTERS.',
          ease(local / 0.6) * Math.min(1, (8.5 - local) / 1),
        );
      if (name === 'ascend' && u > 0.8) {
        background(wc);
        wc.drawImage(board('Y5bAFF7R2i8s', 126, t).canvas, 488, 90, 945, 900);
        ctx.save();
        ctx.globalAlpha = ease((u - 0.8) / 0.2);
        ctx.drawImage(work, 0, 0);
        ctx.restore();
      }
      if (name === 'charge') subtitle(ctx, '集结，突破，反击。', 'TURN THE TIDE', ease(local / 0.25));
      if (name === 'resolve')
        subtitle(ctx, '一格之间，改写天下。', 'YOUR MOVE. YOUR EMPIRE.', ease(local / 0.35));
    } else if (name === 'charge_compare') {
      // Full-bleed split screen: the 3D camera fills the left half; original
      // numeric cells fill the right. Only a thin vertical line separates them.
      const frame = layered
        ? scene.present('charge', local, duration, [-480, 0, 1920, 1080])
        : scene?.renderAt('charge', local, duration);
      if (frame) {
        if (layered) ctx.clearRect(0, 0, 960, 1080);
        else ctx.drawImage(frame, frame.width * 0.25, 0, frame.width * 0.5, frame.height, 0, 0, 960, 1080);
      }
      const b = board(fr.source, fr.tick, t);
      b.draw(ctx, shot.roi || plan.comparison.roi, [960, 0, 960, 1080], 'cover');
      const shade = ctx.createLinearGradient(0, 0, 0, 200);
      shade.addColorStop(0, 'rgba(0,0,0,.65)');
      shade.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, W, 200);
      text(ctx, '概念战场', 480, 54, 28, WHITE, 3, 'cn', true);
      text(ctx, '真实对局', 1440, 54, 28, WHITE, 3, 'cn', true);
      subtitle(ctx, '集结，突破，反击。', 'TURN THE TIDE', 1, 817, 1080);
      ctx.fillStyle = 'rgba(226,194,132,.9)';
      ctx.fillRect(959, 0, 2, 1080);
      tag = '左：概念战场 · 右：公开真实对局';
    } else if (name === 'end') {
      if (!endBackground) {
        endBackground = surface();
        const ec = endBackground.getContext('2d', { willReadFrequently: true });
        ec.filter = 'blur(5px)';
        const frame = scene?.renderAt('resolve', 119 / 30, 4) || lastScene;
        if (frame) ec.drawImage(frame, 0, 0, W, H);
        ec.filter = 'none';
        ec.fillStyle = 'rgba(6,13,20,.8)';
        ec.fillRect(0, 0, W, H);
      }
      ctx.drawImage(endBackground, 0, 0);
      crown(ctx, W / 2, 230, 98);
      text(ctx, 'ROKA', W / 2, 338, 125, WHITE, 18, 'latin', true);
      text(ctx, '一格之间，改写天下。', W / 2, 535, 41, GOLD, 5, 'serif', true);
      text(ctx, 'https://roka.oim.moe:444', W / 2, 660, 42, WHITE, 1, 'sans', true);
      if (assets.qr) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(assets.qr, W / 2 - 83, 764, 166, 166);
        ctx.imageSmoothingEnabled = true;
      }
      tag = '即刻加入 · 最多 16 人实时对战';
    } else {
      nativeScene(ctx, t, fr, name);
      tag = name.startsWith('sixteen') ? '16 方本地模拟对局' : '公开真实对局 · 节选';
    }
    ctx.drawImage(vignette, 0, 0);
    if (name !== 'charge_compare') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, 76);
      ctx.fillRect(0, 1004, W, 76);
      text(ctx, 'ROKA', 74, 25, 23, GOLD, 2, 'latin');
      plain(ctx, tag, W - 75, 31, 16, '#8b989a', 'cn', true);
    }
    const fade =
      name === 'prologue'
        ? Math.min(1, t / 0.7)
        : name === 'end'
          ? Math.min(1, (plan.duration - t) / 1.2)
          : 1;
    if (fade < 1) {
      ctx.fillStyle = `rgba(0,0,0,${1 - fade})`;
      ctx.fillRect(0, 0, W, H);
    }
    return { name, time: t, shot: fr.shot };
  }
  return {
    renderAt,
    dispose() {
      disposed = true;
      for (const b of boards.values()) b.dispose();
      boards.clear();
      backgrounds.clear();
      ticksCache.clear();
      for (const c of [work, vignette, smoke, endBackground])
        if (c) {
          c.width = 0;
          c.height = 0;
        }
    },
  };
}
function makeSmoke() {
  const out = surface(256, 256),
    c = out.getContext('2d', { willReadFrequently: true }),
    noise = new Float32Array(256 * 256);
  let seed = 491;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  }
  for (const [size, weight] of [
    [5, 0.42],
    [12, 0.28],
    [30, 0.2],
    [70, 0.1],
  ]) {
    const small = surface(size, size),
      sc = small.getContext('2d', { willReadFrequently: true }),
      data = sc.createImageData(size, size);
    for (let k = 0; k < size * size; k++) {
      const v = Math.floor(random() * 255);
      data.data[k * 4] = v;
      data.data[k * 4 + 1] = v;
      data.data[k * 4 + 2] = v;
      data.data[k * 4 + 3] = 255;
    }
    sc.putImageData(data, 0, 0);
    c.drawImage(small, 0, 0, 256, 256);
    const resized = c.getImageData(0, 0, 256, 256).data;
    for (let k = 0; k < noise.length; k++) noise[k] += (resized[k * 4] / 255) * weight;
    small.width = 0;
  }
  const image = c.createImageData(256, 256);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const k = y * 256 + x,
        radius = Math.hypot((x - 128) / 125, (y - 128) / 120),
        a = Math.max(0, Math.min(1, (1 - radius) * 2.4)) * Math.max(0, Math.min(1, 0.48 + noise[k] * 0.7)),
        shade = Math.max(0, Math.min(255, 82 + noise[k] * 105 + (128 - y) * 0.1));
      image.data[k * 4] = shade * 1.04;
      image.data[k * 4 + 1] = shade;
      image.data[k * 4 + 2] = shade * 0.92;
      image.data[k * 4 + 3] = a * 255;
    }
  c.putImageData(image, 0, 0);
  return out;
}
