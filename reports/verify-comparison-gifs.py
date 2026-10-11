import hashlib
import json
import sys
from pathlib import Path

from PIL import Image


directory = Path(sys.argv[1] if len(sys.argv) > 1 else 'release/visual-comparison')
results = []
for path in sorted((directory / 'assets').glob('*/*.gif')):
    with Image.open(path) as image:
        assert image.is_animated and image.n_frames > 1, f'Static GIF: {path}'
        hashes = set()
        duration = 0
        for frame in range(image.n_frames):
            image.seek(frame)
            hashes.add(hashlib.sha256(image.convert('RGB').tobytes()).digest())
            duration += image.info.get('duration', 0)
        assert len(hashes) > 1, f'Identical frames: {path}'
        results.append({
            'file': path.relative_to(directory).as_posix(),
            'frames': image.n_frames,
            'uniqueFrames': len(hashes),
            'durationMs': duration,
            'bytes': path.stat().st_size,
        })
assert len(results) == 38, f'Expected 38 GIFs, found {len(results)}'
for before in (result for result in results if '/before/' in result['file']):
    after = next(result for result in results if result['file'] == before['file'].replace('/before/', '/after/'))
    assert before['frames'] == after['frames'], f'Frame count differs: {before["file"]}'
    assert before['durationMs'] == after['durationMs'], f'Duration differs: {before["file"]}'
(directory / 'gif-checks.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print(json.dumps({
    'gifs': len(results),
    'pairs': len(results) // 2,
    'minFrames': min(result['frames'] for result in results),
    'maxFrames': max(result['frames'] for result in results),
    'minUniqueFrames': min(result['uniqueFrames'] for result in results),
    'gifBytes': sum(result['bytes'] for result in results),
}))
