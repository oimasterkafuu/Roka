/** Native ROKA tiles, retaining the original 42 × 40 captured table geometry. */
export const PALETTE = [
  '#808080',
  '#ff0000',
  '#008000',
  '#0000ff',
  '#800080',
  '#008080',
  '#004600',
  '#ffa500',
  '#a52a2a',
  '#800000',
  '#ec7063',
  '#935116',
  '#1a5276',
  '#2ecc71',
  '#641e16',
  '#b7950b',
  '#ff5733',
];
export const CELL_W = 42;
export const CELL_H = 40;
export function isolatedOpacity(encoded, filmTime) {
  const half = encoded === 1 ? 0.2 : 0.5;
  return encoded && Math.floor((filmTime + 1e-8) / half) % 2 ? 0.45 : 1;
}
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
export function frameIndex(ticks, tick) {
  let lo = 0,
    hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ticks[mid] <= tick) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}
/** Indexed checkpoints bound arbitrary backward/forward seeks to 63 delta applications. */
export class ReplayState {
  constructor(data) {
    this.data = data;
    this.length = data.n * data.m;
    this.grid = new Uint16Array(this.length);
    this.army = new Uint32Array(this.length);
    this.isolated = new Uint8Array(this.length);
    this.changed = [];
    this.dirty = new Uint8Array(this.length);
    this.checkpoints = [];
    this.apply(data.initial, false);
    this.checkpoints.push([this.grid.slice(), this.army.slice(), this.isolated.slice()]);
    for (let i = 1; i < data.ticks.length; i++) {
      this.apply(data.diffs[i - 1], false);
      if (i % 64 === 0) this.checkpoints.push([this.grid.slice(), this.army.slice(), this.isolated.slice()]);
    }
    this.index = -1;
  }
  mark(k) {
    if (!this.dirty[k]) {
      this.dirty[k] = 1;
      this.changed.push(k);
    }
  }
  apply(diff, mark = true) {
    for (let k = 0; k < diff.length; k += 4) {
      const id = diff[k];
      this.grid[id] = diff[k + 1];
      this.army[id] = diff[k + 2];
      this.isolated[id] = diff[k + 3];
      if (mark) this.mark(id);
    }
  }
  seek(tick) {
    for (let i = 0; i < this.changed.length; i++) this.dirty[this.changed[i]] = 0;
    this.changed.length = 0;
    const index = frameIndex(this.data.ticks, tick);
    if (index !== this.index) {
      if (this.index < 0 || index < this.index || index - this.index > 64) {
        const start = index - (index % 64),
          point = this.checkpoints[start / 64];
        this.grid.set(point[0]);
        this.army.set(point[1]);
        this.isolated.set(point[2]);
        for (let k = 0; k < this.length; k++) this.mark(k);
        this.index = start;
      }
      for (let i = this.index + 1; i <= index; i++) this.apply(this.data.diffs[i - 1]);
      this.index = index;
    }
    return this;
  }
  get stats() {
    return this.data.stats[Math.max(0, this.index)];
  }
}
export function createReplayBoard(data, assets = {}) {
  const state = new ReplayState(data),
    surface = canvas(data.m * CELL_W, data.n * CELL_H),
    // CPU backing prevents per-glyph GPU flushes when this board is composited.
    ctx = surface.getContext('2d', { willReadFrequently: true });
  const glyphs = new Map(),
    phases = new Float32Array(state.length);
  phases.fill(-1);
  function glyph(number, resolution = 1) {
    const label = String(number),
      key = label + '@' + resolution;
    let cached = glyphs.get(key);
    if (cached) return cached;
    cached = canvas(CELL_W * resolution, CELL_H * resolution);
    const c = cached.getContext('2d', { willReadFrequently: true });
    const shrink =
      label.length >= 8
        ? 0.44
        : label.length === 7
          ? 0.5
          : label.length === 6
            ? 0.58
            : label.length === 5
              ? 0.7
              : 1;
    c.font = `700 ${14 * shrink * resolution}px Quicksand`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'white';
    c.shadowColor = 'black';
    c.shadowBlur = 2 * resolution;
    c.fillText(label, (CELL_W * resolution) / 2, (CELL_H * resolution) / 2);
    glyphs.set(key, cached);
    return cached;
  }
  function paint(k, opacity, target = ctx, resolution = 1, clear = true) {
    const x = (k % data.m) * CELL_W,
      y = Math.floor(k / data.m) * CELL_H,
      code = state.grid[k];
    if (clear) target.clearRect(x, y, CELL_W, CELL_H);
    // Isolated blink fades toward white like the in-game map on its light page.
    if (opacity < 1) {
      target.fillStyle = '#fff';
      target.fillRect(x, y, CELL_W, CELL_H);
    }
    target.globalAlpha = opacity;
    // CSS td border is part of the cell and therefore participates in opacity.
    target.fillStyle = '#000';
    target.fillRect(x, y, CELL_W, 1);
    target.fillRect(x, y + CELL_H - 1, CELL_W, 1);
    target.fillRect(x, y + 1, 1, CELL_H - 2);
    target.fillRect(x + CELL_W - 1, y + 1, 1, CELL_H - 2);
    target.fillStyle = code < 200 ? PALETTE[code % 50] : code === 204 ? '#808080' : '#dcdcdc';
    target.fillRect(x + 1, y + 1, CELL_W - 2, CELL_H - 2);
    const name =
      code === 201
        ? 'mountain'
        : code === 204 || (code >= 150 && code < 200)
          ? 'swamp'
          : code >= 100 && code < 150
            ? 'crown'
            : code >= 50 && code < 100
              ? 'city'
              : null;
    if (name && assets[name]) target.drawImage(assets[name], x + 5, y + 4, 32, 32);
    if (state.army[k] || code === 50)
      target.drawImage(glyph(state.army[k], resolution), x, y, CELL_W, CELL_H);
    target.globalAlpha = 1;
  }
  return {
    canvas: surface,
    state,
    update(tick, time) {
      state.seek(tick);
      for (let i = 0; i < state.changed.length; i++) {
        const k = state.changed[i],
          a = isolatedOpacity(state.isolated[k], time);
        paint(k, a);
        phases[k] = a;
      }
      // Only blinking cells need repaint between replay ticks; unchanged terrain is cached.
      for (let k = 0; k < state.length; k++)
        if (state.isolated[k]) {
          const a = isolatedOpacity(state.isolated[k], time);
          if (phases[k] !== a && Math.abs(phases[k] - a) > 0.001) {
            paint(k, a);
            phases[k] = a;
          }
        }
      return this;
    },
    draw(context, roi, box, fit = 'contain') {
      const [j, i, cols, rows] = roi || [0, 0, data.m, data.n];
      const [x, y, mw, mh] = box,
        scale = (fit === 'cover' ? Math.max : Math.min)(mw / (cols * CELL_W), mh / (rows * CELL_H));
      const w = Math.round(cols * CELL_W * scale),
        h = Math.round(rows * CELL_H * scale),
        ox = Math.round(x + (mw - w) / 2),
        oy = Math.round(y + (mh - h) / 2);
      context.save();
      context.beginPath();
      context.rect(x, y, mw, mh);
      context.clip();
      if (fit === 'cover' && scale > 2) {
        context.translate(ox - j * CELL_W * scale, oy - i * CELL_H * scale);
        context.scale(scale, scale);
        for (let row = i; row < i + rows; row++)
          for (let col = j; col < j + cols; col++) {
            const k = row * data.m + col;
            paint(k, phases[k], context, Math.ceil(scale), false);
          }
      } else context.drawImage(surface, j * CELL_W, i * CELL_H, cols * CELL_W, rows * CELL_H, ox, oy, w, h);
      context.restore();
      return { ox, oy, scale, roi: [j, i, cols, rows], width: w, height: h };
    },
    dispose() {
      glyphs.clear();
      surface.width = 0;
      surface.height = 0;
      state.checkpoints.length = 0;
    },
  };
}
