import json
import struct
from pathlib import Path
from PIL import Image

root = Path('release/visual-comparison-v2')
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
results = []
for case in manifest['cases']:
    if case['kind'] != 'motion':
        continue
    for config in case['configurations']:
        for phase in ['before', 'after']:
            asset = config[phase]
            for kind in ['video', 'apng', 'gif', 'poster']:
                assert (root / asset[kind]).stat().st_size > 0
            with Image.open(root / asset['apng']) as apng:
                assert apng.n_frames == asset['frames'], (asset['apng'], apng.n_frames, asset['frames'])
                durations = []
                for frame in range(apng.n_frames):
                    apng.seek(frame)
                    durations.append(apng.info['duration'])
                assert all(abs(duration - 1000 / 60) < .05 for duration in durations), (asset['apng'], sorted(set(durations)))
            with Image.open(root / asset['gif']) as gif:
                durations = []
                for frame in range(gif.n_frames):
                    gif.seek(frame)
                    durations.append(gif.info.get('duration', 0))
                assert min(durations) >= 20, (asset['gif'], min(durations))
                assert abs(sum(durations) - asset['seconds'] * 1000) <= 25
            results.append({'case': case['id'], 'config': config['id'], 'phase': phase, 'fps': 60, 'frames': asset['frames'], 'gif_fps': 50})
(root / 'media-qa.json').write_text(json.dumps({'results': results}, indent=2), encoding='utf-8')
print(f'Media: {len(results)} clips verified; APNG exact 60 FPS; GIF timing at 50 FPS; matching pair lengths.')
