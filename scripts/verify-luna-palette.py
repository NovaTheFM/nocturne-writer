import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parent.parent
NAMES = ['lil_mascot.png', 'luna_happy.png', 'luna_congrats.png',
         'luna_love.png', 'luna_absolute.png', 'luna_cry.png']


def main():
    parser = argparse.ArgumentParser(description='Independently verify the RGB palette of the saved Luna PNGs.')
    parser.add_argument('--asset-dir', type=Path, default=ROOT / 'reaper_photo')
    parser.add_argument('--original-dir', type=Path, default=ROOT / 'release/qa/luna/palette-originals')
    args = parser.parse_args()
    palette = json.loads((args.asset_dir / 'luna-palette.json').read_text(encoding='utf-8'))
    allowed = {tuple(color) for color in palette['colors']}
    report = {'paletteSize': len(allowed), 'images': {}}
    for name in NAMES:
        path = args.asset_dir / name
        with Image.open(path) as image:
            if image.mode != 'RGBA' or image.size != (1254, 1254):
                raise RuntimeError(f'Unexpected PNG format or dimensions: {name}')
            data = np.asarray(image).copy()
        used = {tuple(color) for color in np.unique(data[..., :3][data[..., 3] > 0], axis=0)}
        outside = used - allowed
        if outside:
            raise RuntimeError(f'{name}: {len(outside)} RGB colors outside the shared palette')
        alpha_unchanged = None
        original = args.original_dir / name
        if original.exists():
            with Image.open(original) as image:
                alpha_unchanged = bool(np.array_equal(data[..., 3], np.asarray(image.convert('RGBA'))[..., 3]))
            if not alpha_unchanged:
                raise RuntimeError(f'Alpha channel changed: {name}')
        report['images'][name] = {'bytes': path.stat().st_size, 'usedColors': len(used),
                                  'outsidePalette': len(outside), 'alphaUnchanged': alpha_unchanged}
    output = ROOT / 'release/qa/luna/verified-palette.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
