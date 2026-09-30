"""Regenerate src/map/huaxia-land.json from Natural Earth 1:50m land v4.0.0.

Source: https://naturalearth.s3.amazonaws.com/50m_physical/ne_50m_land.zip
License: public domain, https://www.naturalearthdata.com/about/terms-of-use/
Only polygon rings intersecting 65-150 E, 5-60 N are retained; rings are
simplified with Ramer-Douglas-Peucker at 0.06 degrees. No hand-drawn coastline.
Run from the repository root: python3 scripts/generate-huaxia-land.py
"""
import io
import json
import math
import pathlib
import struct
import urllib.request
import zipfile

URL = 'https://naturalearth.s3.amazonaws.com/50m_physical/ne_50m_land.zip'
OUTPUT = pathlib.Path(__file__).resolve().parent.parent / 'src/map/huaxia-land.json'
BBOX = (65, 5, 150, 60)


def simplify(points, tolerance=0.06):
    if len(points) < 4:
        return points
    start, end = points[0], points[-1]
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = dx * dx + dy * dy
    def distance(p):
        t = max(0, min(1, ((p[0] - start[0]) * dx + (p[1] - start[1]) * dy) / length)) if length else 0
        return math.hypot(p[0] - start[0] - t * dx, p[1] - start[1] - t * dy)
    index = max(range(1, len(points) - 1), key=lambda i: distance(points[i]))
    if distance(points[index]) <= tolerance:
        return [start, end]
    return simplify(points[:index + 1], tolerance)[:-1] + simplify(points[index:], tolerance)


def rings(shp):
    offset = 100
    while offset < len(shp):
        length = struct.unpack_from('>I', shp, offset + 4)[0] * 2
        record = offset + 8
        offset = record + length
        kind = struct.unpack_from('<I', shp, record)[0]
        if kind == 0:
            continue
        if kind != 5:
            raise ValueError(f'unexpected shapefile geometry: {kind}')
        part_count, point_count = struct.unpack_from('<II', shp, record + 36)
        parts = list(struct.unpack_from(f'<{part_count}I', shp, record + 44)) + [point_count]
        points_offset = record + 44 + 4 * part_count
        for a, b in zip(parts, parts[1:]):
            points = [struct.unpack_from('<dd', shp, points_offset + 16 * i) for i in range(a, b)]
            if len(points) < 4 or not (min(p[0] for p in points) <= BBOX[2]
                and max(p[0] for p in points) >= BBOX[0]
                and min(p[1] for p in points) <= BBOX[3]
                and max(p[1] for p in points) >= BBOX[1]):
                continue
            # Closed rings need a non-degenerate starting segment for RDP.
            simplified = simplify(points[:-1])
            if len(simplified) >= 3:
                yield [[round(lon, 3), round(lat, 3)] for lon, lat in simplified]


with urllib.request.urlopen(URL, timeout=60) as response:
    archive = zipfile.ZipFile(io.BytesIO(response.read()))
shp = archive.read('ne_50m_land.shp')
OUTPUT.write_text(json.dumps(list(rings(shp)), separators=(',', ':')) + '\n', encoding='utf-8')
print(f'{OUTPUT}: {OUTPUT.stat().st_size} bytes')
