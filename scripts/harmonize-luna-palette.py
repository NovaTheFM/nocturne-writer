import argparse
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
from scipy.spatial import cKDTree


ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'reaper_photo'
QA = ROOT / 'release' / 'qa' / 'luna'
ORIGINALS = QA / 'palette-originals'
CANDIDATES = QA / 'palette-candidates'
NAMES = ['lil_mascot.png', 'luna_happy.png', 'luna_congrats.png',
         'luna_love.png', 'luna_absolute.png', 'luna_cry.png']
FAMILIES = ['dark-purple', 'lavender', 'eyes', 'skin', 'gold', 'pink', 'neutral']
EYES = {
    'lil_mascot.png': [(452, 550, 540, 645), (657, 550, 752, 651)],
    'luna_happy.png': [(454, 547, 544, 647), (658, 548, 752, 652)],
    'luna_congrats.png': [(446, 525, 545, 630), (655, 545, 752, 650)],
    'luna_love.png': [(460, 518, 561, 632), (665, 540, 768, 657)],
    'luna_cry.png': [(444, 526, 545, 631), (648, 537, 750, 643)],
    'luna_absolute.png': [(438, 465, 550, 575), (608, 504, 728, 626)],
}
RGB_TO_XYZ = np.array([[.4124564, .3575761, .1804375],
                       [.2126729, .7151522, .0721750],
                       [.0193339, .1191920, .9503041]])


def read(path):
    with Image.open(path) as image:
        return np.asarray(image.convert('RGBA')).copy()


def rgb_to_lab(rgb):
    srgb = np.asarray(rgb, dtype=np.float64) / 255
    linear = np.where(srgb <= .04045, srgb / 12.92, ((srgb + .055) / 1.055) ** 2.4)
    xyz = linear @ RGB_TO_XYZ.T / np.array([.95047, 1, 1.08883])
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], axis=-1)


def ramp(values, low, high):
    return np.clip((values - low) / (high - low), 0, 1)


def material_weights(data, name):
    rgb = data[..., :3].astype(np.float32) / 255
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
    purple = ramp(hue, 205, 225) * (1 - ramp(hue, 315, 335))
    accent = ramp(saturation, .32, .43) * ramp(value, .45, .58)
    accent = np.maximum(accent, ramp(hue, 290, 305) * ramp(saturation, .18, .28) * ramp(value, .4, .55))
    warm_hue = (hue + 180) % 360 - 180
    warm = ramp(warm_hue, -45, -30) * (1 - ramp(warm_hue, 22, 35))
    pink = ramp(saturation, .22, .36)
    gold = ramp(hue, 22, 35) * (1 - ramp(hue, 70, 90))
    neutral = (1 - ramp(saturation, .025, .07))
    weights = np.stack([purple * (1 - accent), purple * accent, np.zeros_like(value),
                        warm * (1 - pink), gold, warm * pink, neutral], axis=-1)
    # Violet irises in the generated sprites otherwise overlap the clothing hues.
    for x1, y1, x2, y2 in EYES[name]:
        eye = purple[y1:y2, x1:x2] * ramp(saturation[y1:y2, x1:x2], .22, .34) * ramp(value[y1:y2, x1:x2], .25, .38)
        region = weights[y1:y2, x1:x2]
        region[..., :2] *= (1 - eye[..., None])
        region[..., FAMILIES.index('eyes')] = eye
    total = weights.sum(axis=-1)
    weights[..., -1] += np.maximum(1 - total, 0)
    weights /= np.maximum(weights.sum(axis=-1, keepdims=True), 1e-9)
    return weights


def compact_palette(colors, subdivisions=4):
    unique = np.unique(colors, axis=0)
    if len(unique) <= 256:
        return unique
    if subdivisions > 1:
        order = np.argsort(rgb_to_lab(colors)[:, 0])
        return np.unique(np.concatenate([compact_palette(part, subdivisions=1)
                                         for part in np.array_split(colors[order], subdivisions)]), axis=0)
    width = 512
    strip = np.zeros((int(np.ceil(len(colors) / width)), width, 3), dtype=np.uint8)
    strip.reshape(-1, 3)[:len(colors)] = colors
    strip.reshape(-1, 3)[len(colors):] = colors[-1]
    indexed = Image.fromarray(strip).quantize(colors=256, method=Image.Quantize.MEDIANCUT,
                                             dither=Image.Dither.NONE)
    table = np.asarray(indexed.getpalette(), dtype=np.uint8).reshape(-1, 3)
    return np.unique(table[np.unique(np.asarray(indexed))], axis=0)


def reference_profile():
    reference = read(ORIGINALS / 'lil_mascot.png')
    weights = material_weights(reference, 'lil_mascot.png')
    labels = weights.argmax(axis=-1)
    opaque = reference[..., 3] >= 240
    profile = {}
    for index, name in enumerate(FAMILIES):
        colors = reference[..., :3][(weights[..., index] >= .8) & opaque]
        palette_colors = reference[..., :3][(labels == index) & opaque]
        if name == 'pink':
            # Match open mouths to the existing happy sprite, rather than the closed lip.
            happy = read(ORIGINALS / 'luna_happy.png')
            happy_weights = material_weights(happy, 'luna_happy.png')
            colors = happy[..., :3][(happy_weights[..., index] >= .8) & (happy[..., 3] >= 240)]
            palette_colors = happy[..., :3][(happy_weights.argmax(axis=-1) == index) & (happy[..., 3] >= 240)]
        palette = compact_palette(palette_colors)
        lightness = rgb_to_lab(colors)[..., 0]
        quantiles = np.quantile(lightness, np.linspace(0, 1, 65))
        profile[name] = {'palette': palette, 'quantiles': quantiles,
                         'rgbQuantiles': np.quantile(colors, np.linspace(0, 1, 65), axis=0)}
    return profile


def calibration_swatch(data, name, family, weights):
    rectangles = {'dark-purple': (535, 320, 610, 395),
                  'lavender': (640, 230, 705, 265),
                  'skin': (570, 590, 615, 635)}
    if family == 'pink':
        x1, y1, x2, y2 = (540, 610, 665, 720) if name != 'luna_absolute.png' else (470, 685, 600, 760)
        area = data[y1:y2, x1:x2]
        core = (area[..., 3] >= 240) & (weights[y1:y2, x1:x2, FAMILIES.index('pink')] >= .8) & (area[..., :3].max(axis=-1) >= 200)
        if np.count_nonzero(core) >= 200:
            return np.median(area[..., :3][core], axis=0)
        return None
    if family not in rectangles or name == 'luna_absolute.png':
        return None
    x1, y1, x2, y2 = rectangles[family]
    area = data[y1:y2, x1:x2]
    core = (area[..., 3] >= 240) & (weights[y1:y2, x1:x2, FAMILIES.index(family)] >= .8)
    if np.count_nonzero(core) < 32:
        return None
    return np.median(area[..., :3][core], axis=0)


def harmonize(data, name, profile, shared_palette):
    rgb = data[..., :3]
    lab = rgb_to_lab(rgb)
    weights = material_weights(data, name)
    visible = data[..., 3] > 0
    opaque = data[..., 3] >= 240
    correction = np.zeros_like(lab)
    statistics = {}
    reference = read(ORIGINALS / 'lil_mascot.png')
    reference_weights = material_weights(reference, 'lil_mascot.png')
    happy = read(ORIGINALS / 'luna_happy.png')
    happy_weights = material_weights(happy, 'luna_happy.png')
    for index, family in enumerate(FAMILIES):
        weight = gaussian_filter(weights[..., index], sigma=2)
        core = (weights[..., index] >= .8) & opaque
        if np.count_nonzero(core) < 32:
            continue
        quantiles = np.quantile(lab[..., 0][core], np.linspace(0, 1, 65))
        source_rgb = np.quantile(rgb[core], [.125, .5, .875], axis=0)
        target_rgb = profile[family]['rgbQuantiles'][[8, 32, 56]]
        scale = np.clip((target_rgb[2] - target_rgb[0]) / np.maximum(source_rgb[2] - source_rgb[0], 1), .8, 1.2)
        source_anchor = calibration_swatch(data, name, family, weights)
        reference_anchor = calibration_swatch(reference, 'lil_mascot.png', family, reference_weights)
        if family == 'pink':
            reference_anchor = calibration_swatch(happy, 'luna_happy.png', family, happy_weights)
            scale = np.ones(3)
        source_anchor = source_rgb[1] if source_anchor is None else source_anchor
        reference_anchor = target_rgb[1] if reference_anchor is None else reference_anchor
        mapped = (rgb.astype(np.float64) - source_anchor) * scale + reference_anchor
        mapped_lab = rgb_to_lab(np.clip(mapped, 0, 255))
        if family in ['dark-purple', 'lavender', 'eyes']:
            direction = rgb_to_lab(reference_anchor)[1:]
            direction /= max(np.linalg.norm(direction), 1e-9)
            chroma = np.linalg.norm(mapped_lab[..., 1:], axis=-1)
            mapped_lab[..., 1:] = chroma[..., None] * direction
        correction += weight[..., None] * (mapped_lab - lab)
        statistics[family] = {'pixels': int(np.count_nonzero(core)),
                              'sourceLightness': quantiles[[8, 32, 56]].round(3).tolist(),
                              'referenceLightness': profile[family]['quantiles'][[8, 32, 56]].round(3).tolist()}
    # Only soften the correction field across material boundaries, preserving the artwork.
    for channel in range(3):
        correction[..., channel] = gaussian_filter(correction[..., channel], sigma=1.25)
    corrected = lab if name == 'lil_mascot.png' else lab + correction
    palette_lab = rgb_to_lab(shared_palette)
    tree = cKDTree(palette_lab)
    _, indices = tree.query(corrected[visible], workers=-1)
    result = data.copy()
    result[..., :3][visible] = shared_palette[indices]
    if not np.array_equal(result[..., 3], data[..., 3]):
        raise RuntimeError(f'Alpha channel changed: {name}')
    used = np.unique(result[..., :3][visible], axis=0)
    outside = set(map(tuple, used.tolist())) - set(map(tuple, shared_palette.tolist()))
    if outside:
        raise RuntimeError(f'Colors outside shared palette: {name}')
    return result, {'size': [int(data.shape[1]), int(data.shape[0])],
                    'alphaUnchanged': True, 'paletteColorsUsed': len(used),
                    'colorsOutsideSharedPalette': len(outside), 'materials': statistics}


def main():
    parser = argparse.ArgumentParser(description='Map every visible Luna RGB pixel to one shared palette.')
    parser.add_argument('--apply', action='store_true', help='Copy reviewed candidates and their shared palette into reaper_photo.')
    args = parser.parse_args()
    ORIGINALS.mkdir(parents=True, exist_ok=True)
    CANDIDATES.mkdir(parents=True, exist_ok=True)
    for name in NAMES:
        backup = ORIGINALS / name
        if not backup.exists():
            shutil.copy2(ASSETS / name, backup)
    canonical = ASSETS / 'luna-palette.json'
    if canonical.exists():
        palette_document = json.loads(canonical.read_text(encoding='utf-8'))
        profile = {name: {'palette': np.asarray(item['colors'], dtype=np.uint8),
                          'quantiles': np.asarray(item['lightnessQuantiles']),
                          'rgbQuantiles': np.asarray(item['rgbQuantiles'])}
                   for name, item in palette_document['materials'].items()}
        shared_palette = np.asarray(palette_document['colors'], dtype=np.uint8)
    else:
        profile = reference_profile()
        shared_palette = np.unique(np.concatenate([item['palette'] for item in profile.values()]), axis=0)
        palette_document = {'reference': 'lil_mascot.png', 'mouthReference': 'luna_happy.png',
                            'colors': shared_palette.tolist(),
                            'materials': {name: {'colors': item['palette'].tolist(),
                                                 'lightnessQuantiles': item['quantiles'].tolist(),
                                                 'rgbQuantiles': item['rgbQuantiles'].tolist()}
                                          for name, item in profile.items()}}
    palette_path = CANDIDATES / 'luna-palette.json'
    palette_path.write_text(json.dumps(palette_document, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    report = {'method': 'shared-full-gamut-palette', 'paletteSize': len(shared_palette), 'images': {}}
    for name in NAMES:
        result, measured = harmonize(read(ORIGINALS / name), name, profile, shared_palette)
        Image.fromarray(result).save(CANDIDATES / name)
        report['images'][name] = measured
        if args.apply:
            shutil.copy2(CANDIDATES / name, ASSETS / name)
    if args.apply:
        shutil.copy2(palette_path, ASSETS / palette_path.name)
    (QA / 'palette-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'paletteSize': len(shared_palette), 'images': {
        name: {key: value for key, value in entry.items() if key != 'materials'}
        for name, entry in report['images'].items()}}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
