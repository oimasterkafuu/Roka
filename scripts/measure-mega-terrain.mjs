export function measurePlainRegions({ n, m, grid_type: tiles }) {
  const heights = new Uint32Array(m + 1);
  const clear = new Uint32Array(m + 1);
  let square = 0,
    obstacleFreeSquare = 0,
    longSideAtWidthSix = 0,
    interiorObstacles = 0;
  let rectangle = { height: 0, width: 0, area: 0 };
  for (let row = 0; row < n; row++) {
    const stack = [];
    let diagonal = 0;
    for (let col = 0; col <= m; col++) {
      if (col < m) {
        const tile = tiles[row * m + col],
          obstacle = tile === 201 || tile === 204;
        heights[col] = tile === 200 ? heights[col] + 1 : 0;
        const above = clear[col + 1];
        clear[col + 1] = obstacle ? 0 : 1 + Math.min(above, clear[col], diagonal);
        diagonal = above;
        obstacleFreeSquare = Math.max(obstacleFreeSquare, clear[col + 1]);
        if (obstacle && row > 0 && col > 0 && row < n - 1 && col < m - 1) interiorObstacles++;
      }
      while (stack.length && heights[stack.at(-1)] > heights[col]) {
        const height = heights[stack.pop()],
          width = col - (stack.at(-1) ?? -1) - 1;
        square = Math.max(square, Math.min(height, width));
        if (Math.min(height, width) >= 6) longSideAtWidthSix = Math.max(longSideAtWidthSix, height, width);
        if (height * width > rectangle.area) rectangle = { height, width, area: height * width };
      }
      stack.push(col);
    }
  }
  return { square, rectangle, obstacleFreeSquare, longSideAtWidthSix, interiorObstacles };
}

export function interiorObstacleMasks({ n, m, grid_type: tiles }) {
  const side = 31;
  const masks = [];
  for (const swap of [false, true])
    for (const flipRow of [false, true])
      for (const flipCol of [false, true]) {
        masks.push(
          Uint8Array.from({ length: side * side }, (_, index) => {
            const row = Math.floor(index / side),
              col = index % side;
            const vertical = 1 + Math.floor((((swap ? col : row) + 0.5) * (n - 2)) / side);
            const horizontal = 1 + Math.floor((((swap ? row : col) + 0.5) * (m - 2)) / side);
            const tile =
              tiles[
                (flipRow ? n - 1 - vertical : vertical) * m + (flipCol ? m - 1 - horizontal : horizontal)
              ];
            return Number(tile === 201 || tile === 204);
          }),
        );
      }
  return masks;
}

export function obstacleDistance(mask, variants) {
  return Math.min(
    ...variants.map((other) => {
      let changed = 0,
        occupied = 0;
      for (let cell = 0; cell < mask.length; cell++) {
        changed += mask[cell] ^ other[cell];
        occupied += mask[cell] | other[cell];
      }
      return changed / Math.max(1, occupied);
    }),
  );
}
