#!/usr/bin/env python3
"""Subset the original film fonts to the introduction's actual character set.

Usage: python3 tools/build-intro-fonts.py [trailer-directory] [output-directory]
Requires fonttools[woff] and brotli. Does not download fonts.
"""
from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
TRAILER = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/workspace/roka-trailer')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'static/intro/assets'
OUT.mkdir(parents=True, exist_ok=True)
source = (ROOT / 'static/intro/director.js').read_text() + (ROOT / 'static/intro/replay-board.js').read_text()
# Include ASCII for live stats/tick labels, dynamic numeric tiles, and the URL.
characters = ''.join(sorted(set(source) | set(chr(i) for i in range(32, 127))))
# Only literal CJK characters and printable Latin are displayed by this film.
characters = ''.join(c for c in characters if 32 <= ord(c) <= 126 or '\u3000' <= c <= '\u9fff' or c in '·×。！？：，、')
fonts = [
    ('serif', 'RokaIntroSerif', TRAILER / 'v4/assets/NotoSerifCJKsc-Bold.otf', 700),
    ('cn', 'RokaIntroCN', Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'), 700),
    ('latin', 'RokaIntroLatin', Path('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'), 400),
    ('sans', 'RokaIntroSans', Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'), 400),
    ('quicksand', 'Quicksand', ROOT / 'static/Quicksand-Bold.otf', 700),
]
manifest = []
for key, family, origin, weight in fonts:
    target = OUT / f'intro-{key}.woff2'
    text = '0123456789' if key == 'quicksand' else characters
    args = [sys.executable, '-m', 'fontTools.subset', str(origin), f'--text={text}', '--flavor=woff2', f'--output-file={target}', '--layout-features=*', '--no-recalc-timestamp', '--notdef-glyph', '--notdef-outline', '--recommended-glyphs']
    if origin.suffix == '.ttc': args.append('--font-number=0')
    subprocess.run(args, check=True)
    manifest.append({'key': key, 'family': family, 'weight': weight, 'file': target.name})
    print(f'{target.name}: {target.stat().st_size} bytes ({family}, weight {weight})')
(OUT / 'fonts.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
