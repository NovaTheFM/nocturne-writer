import argparse
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter


ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'reaper_photo'
QA = ROOT / 'release' / 'qa' / 'luna'
ORIGINALS = QA / 'palette-originals'
CANDIDATES = QA / 'palette-candidates'
NAMES = ['lil_mascot.png', 'luna_happy.png', 'luna_congrats.png',
         'luna_love.png', 'luna_absolute.png', 'luna_cry.png']


def ramp(values, low, high):
    return np.clip((values - low) / (high - low), 0, 1)


def color_groups(rgb):
    value = rgb.max(axis=-1)
    delta = value - rgb.min(axis=-1)
    saturation = delta / np.maximum(value, 1e-9)
    hue = np.zeros_like(value)
    red = (rgb[..., 0] == value) & (delta > 0)
    green = (rgb[..., 1] == value) & ~red & (delta > 0)
    blue = (delta > 0) & ~red & ~green
    hue[red] = ((rgb[..., 1] - rgb[..., 2])[red] / delta[red]) % 6
    hue[green] = (rgb[..., 2] - rgb[..., 0])[green] / delta[green] + 2
    hue[blue] = (rgb[..., 0] - rgb[..., 1])[blue] / delta[blue] + 4
    hue *= 60
    warm_hue = (hue + 180) % 360 - 180

    def interval(values, low, high, feather):
        return ramp(values, low - feather, low) * (1 - ramp(values, high, high + feather))

    purple = interval(hue, 240, 295, 5)
    dark = purple * interval(saturation, .14, .38, .06) * interval(value, .18, .65, .06)
    accent = interval(hue, 266, 295, 4) * ramp(saturation, .33, .42) * ramp(value, .52, .65)
    eyes = interval(hue, 240, 260, 5) * ramp(saturation, .3, .42) * ramp(value, .55, .65)
    skin = interval(warm_hue, -8, 25, 5) * (1 - ramp(saturation, .24, .3)) * ramp(value, .65, .8)
    gold = interval(hue, 30, 58, 5) * interval(saturation, .1, .5, .08) * ramp(value, .65, .8)
    pink = interval(warm_hue, -30, 8, 7) * ramp(saturation, .25, .33) * ramp(value, .5, .65)
    hearts = interval(hue, 298, 322, 5) * ramp(saturation, .2, .3) * ramp(value, .55, .7)
    return {'dark-purple': dark, 'lavender': accent, 'eyes': eyes,
            'skin': skin, 'gold': gold, 'pink': pink, 'hearts': hearts}


def read(path):
    with Image.open(path) as image:
        return np.asarray(image.convert('RGBA')).copy()


def anchors(data, groups):
    rgb = data[..., :3].astype(np.float32)
    opaque = data[..., 3] >= 240
    result = {}
    for name, weight in groups.items():
        core = (weight >= .95) & opaque
        if np.count_nonzero(core) >= 100:
            result[name] = np.median(rgb[core], axis=0)
    return result


def harmonize(data, target):
    rgb = data[..., :3].astype(np.float32)
    groups = color_groups(rgb / 255)
    source = anchors(data, groups)
    weights = {name: gaussian_filter(weight, sigma=2) for name, weight in groups.items() if name in source and name in target}
    total = sum(weights.values())
    normalization = np.maximum(total, 1)[..., None]
    corrected = rgb.copy()
    opaque = data[..., 3] >= 240
    for _ in range(4):
        correction = np.zeros_like(rgb)
        for name, weight in weights.items():
            core = (groups[name] >= .95) & opaque
            current = np.median(corrected[core], axis=0)
            correction += weight[..., None] * (target[name] - current)
        corrected = np.clip(corrected + correction / normalization, 0, 255)
    result = data.copy()
    visible = data[..., 3] > 0
    result[..., :3][visible] = np.round(corrected[visible]).astype(np.uint8)
    measured = {}
    for name, weight in weights.items():
        core = (groups[name] >= .95) & opaque
        measured[name] = np.median(result[..., :3][core], axis=0).tolist()
    if not np.array_equal(result[..., 3], data[..., 3]):
        raise RuntimeError('Alpha channel changed')
    return result, measured


def main():
    parser = argparse.ArgumentParser(description='Match Luna material colors without redrawing pixels or changing alpha.')
    parser.add_argument('--apply', action='store_true', help='Copy reviewed candidates into reaper_photo.')
    args = parser.parse_args()
    ORIGINALS.mkdir(parents=True, exist_ok=True)
    CANDIDATES.mkdir(parents=True, exist_ok=True)
    for name in NAMES:
        backup = ORIGINALS / name
        if not backup.exists():
            shutil.copy2(ASSETS / name, backup)
    reference = read(ORIGINALS / 'lil_mascot.png')
    target = anchors(reference, color_groups(reference[..., :3].astype(np.float32) / 255))
    happy = read(ORIGINALS / 'luna_happy.png')
    happy_anchors = anchors(happy, color_groups(happy[..., :3].astype(np.float32) / 255))
    # The closed-mouth reference has no usable sample of the open-mouth pink.
    target['pink'] = happy_anchors['pink']
    target['hearts'] = target['lavender'] + np.array([30, 30, 30])
    target['hearts'] = np.clip(target['hearts'], 0, 255)
    report = {'reference': 'lil_mascot.png', 'target': {key: value.tolist() for key, value in target.items()}, 'images': {}}
    for name in NAMES:
        original = read(ORIGINALS / name)
        if name == 'lil_mascot.png':
            result = original.copy()
            measured = {key: value.tolist() for key, value in anchors(original, color_groups(original[..., :3].astype(np.float32) / 255)).items()}
        else:
            result, measured = harmonize(original, target)
        Image.fromarray(result).save(CANDIDATES / name)
        report['images'][name] = {'size': list(result.shape[:2]), 'alphaUnchanged': bool(np.array_equal(result[..., 3], original[..., 3])), 'anchors': measured}
        if args.apply and name != 'lil_mascot.png':
            shutil.copy2(CANDIDATES / name, ASSETS / name)
    (QA / 'palette-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
