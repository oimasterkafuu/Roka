"""One-time background/score preparation from the backed-up film (Pillow + FFmpeg).
The normal website build never calls this tool. Input is not an MP4.
Usage: python scripts/intro/prepare-intro-media.py /path/to/roka-trailer /path/to/early-background-sprite.png
"""
from pathlib import Path
import hashlib
import io
import json
import subprocess
import sys
import tempfile
from PIL import Image
source, sprite = Path(sys.argv[1]), Path(sys.argv[2])
assets = Path('static/intro/assets')
manifest = json.loads((assets / 'manifest.json').read_text())
def emit(name, data):
    p = Path(name)
    filename = p.stem + '.' + hashlib.sha256(data).hexdigest()[:16] + p.suffix
    (assets / filename).write_bytes(data)
    return '/intro/assets/' + filename
image = Image.open(sprite)
buffer = io.BytesIO()
image.save(buffer, format='WEBP', quality=90, method=6)
manifest['images']['background'] = emit('background.webp', buffer.getvalue())
for key in ['crown', 'city', 'mountain', 'swamp']:
    manifest['images'][key] = emit(key + '.png', (Path('static') / (key + '.png')).read_bytes())
manifest['images']['qr'] = emit('join-qr.png', (source / 'v4/assets/join-qr.png').read_bytes())
with tempfile.TemporaryDirectory() as temp:
    output = Path(temp) / 'score.mp3'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(source / 'v4/assets/soundtrack-final.wav'), '-filter_complex', '[0:a]asplit=3[a][b][c];[a]atrim=0:88,asetpts=PTS-STARTPTS[x];[b]atrim=84:88,asetpts=PTS-STARTPTS[y];[c]atrim=88:120,asetpts=PTS-STARTPTS[z];[x][y][z]concat=n=3:v=0:a=1[out]', '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '192k', str(output)], check=True)
    manifest['files']['score.mp3'] = emit('score.mp3', output.read_bytes())
(assets / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
