import { clamp, mix, smoothstep, rotate } from "./math.js";

export function faceWorld(rig, x, y) {
  const head = rig.manifest.faceRig.head;
  if (!head) return [x, y];
  const c = Math.cos(head.angle),
    s = Math.sin(head.angle);
  return [head.origin[0] + x * c - y * s, head.origin[1] + x * s + y * c];
}
function profile(values, u) {
  const x = clamp(u, 0, 1) * (values.length - 1),
    i = Math.min(values.length - 2, Math.floor(x));
  return mix(values[i], values[i + 1], x - i);
}

// Silent articulation targets. Timing is independent of text or audio.
const syllables = [
  [0.18, 0.12, 0.75, 0],
  [0.24, 0.94, 1.02, 0],
  [0.17, 0.36, 1.08, 0],
  [0.22, 0, 0.72, 0],
  [0.25, 0.74, 0.57, 0.9],
  [0.18, 0.42, 0.92, 0.1],
  [0.19, 0.03, 0.73, 0],
  [0.24, 0.86, 1, 0.05],
  [0.2, 0.31, 0.66, 0.65],
];
const cycle = syllables.reduce((n, s) => n + s[0], 0);
export function sampleArticulation(time) {
  let phase = ((time % cycle) + cycle) % cycle;
  for (let index = 0; index < syllables.length; index++) {
    const [duration, opening, width, round] = syllables[index];
    if (phase < duration) {
      const previous =
        syllables[(index + syllables.length - 1) % syllables.length];
      const blend = smoothstep(0, duration * 0.45, phase);
      return {
        opening: mix(previous[1], opening, blend),
        width: mix(previous[2], width, blend),
        round: mix(previous[3], round, blend),
      };
    }
    phase -= duration;
  }
  return { opening: 0.1, width: 0.75, round: 0 };
}
export function blinkClosure(elapsed) {
  if (elapsed < 0 || elapsed >= 0.22) return 0;
  if (elapsed < 0.06) return smoothstep(0, 0.06, elapsed);
  if (elapsed < 0.085) return 1;
  return 1 - smoothstep(0.085, 0.22, elapsed);
}
export function boundsAt(shape, u) {
  if (shape.upper)
    return [
      shape.y + profile(shape.upper, u),
      shape.y + profile(shape.lower, u),
    ];
  const arch = 4 * u * (1 - u);
  const base = shape.y + shape.slope * u;
  return [base + shape.top * arch, base + shape.bottom * arch];
}
export function surfacePoint(shape, u, v) {
  const [top, bottom] = boundsAt(shape, u);
  return [shape.x + u * shape.width, mix(top, bottom, v)];
}
export function nativeInkPoint(shape, base, rect, u, v, kind = "upper") {
  const x = rect[0] + rect[2] * u,
    y = rect[1] + rect[3] * v,
    t = (x - base.x) / base.width;
  return [
    shape.x + ((x - base.x) * shape.width) / base.width,
    y + shape.y - base.y + profile(shape[kind], t) - profile(base[kind], t),
  ];
}
export function nativeSceneInkPoint(
  rig,
  shape,
  base,
  rect,
  u,
  v,
  kind = "upper",
) {
  const head = rig.manifest.faceRig.head,
    c = Math.cos(head.angle),
    s = Math.sin(head.angle),
    x = rect[0] + u * rect[2] - head.origin[0],
    y = rect[1] + v * rect[3] - head.origin[1];
  return nativeInkPoint(
    shape,
    base,
    [x * c + y * s, -x * s + y * c, 0, 0],
    0,
    0,
    kind,
  );
}
export function strokePoint(
  shape,
  u,
  v,
  { height = 2, lower = false, extension = 0 } = {},
) {
  const range =
    shape.lashRange && height > 8
      ? shape.lashRange
      : [-extension, 1 + extension];
  const t = mix(range[0], range[1], u);
  if (shape.upper) {
    const bounded = clamp(t, 0, 1),
      values = lower ? shape.lower : shape.upper;
    const step = 1 / (values.length - 1),
      slope =
        (profile(values, clamp(bounded + step, 0, 1)) -
          profile(values, clamp(bounded - step, 0, 1))) /
        (shape.width *
          (clamp(bounded + step, 0, 1) - clamp(bounded - step, 0, 1)));
    const length = Math.hypot(1, slope),
      offset = (v - 0.5) * height;
    return [
      shape.x + t * shape.width - (offset * slope) / length,
      shape.y + profile(values, bounded) + offset / length,
    ];
  }
  const bounded = clamp(t, 0, 1),
    curve = lower ? shape.bottom : shape.top;
  const [top, bottom] = boundsAt(shape, bounded);
  const slope = (shape.slope + curve * 4 * (1 - 2 * bounded)) / shape.width;
  const length = Math.hypot(1, slope),
    offset = (v - 0.5) * height;
  return [
    shape.x + t * shape.width - (offset * slope) / length,
    (lower ? bottom : top) + offset / length,
  ];
}
export function eyeShape(rig, side, closure) {
  const base = rig.manifest.faceRig.eyes[side],
    weights = rig.getEmotionWeights();
  if (base.upper) {
    const upper = [],
      lower = [];
    for (let i = 0; i < base.upper.length; i++) {
      const line = mix(base.closed[i], base.happyClosed[i], weights.happy),
        wide = 1 + weights.surprised * 0.08;
      const boundary = mix(
        base.upper[0],
        base.upper.at(-1),
        i / (base.upper.length - 1),
      );
      upper.push(
        mix(boundary + (base.upper[i] - boundary) * wide, line, closure),
      );
      lower.push(mix(base.lower[i], line, closure));
    }
    return {
      ...base,
      upper,
      lower,
      id: "eye-" + side,
      irisX:
        base.iris[0] +
        (rig.options.tracking && rig.pointer.inside
          ? clamp((rig.pointer.x - 619) / 250, -1, 1) * 1.2
          : 0),
      irisY: base.iris[1],
    };
  }
  const line = mix(base.closed, 5, weights.happy);
  const upper = mix(base.top, line, closure),
    lower = mix(base.bottom, line, closure);
  return {
    ...base,
    top: upper,
    bottom: lower,
    lashHeight: base.lashHeight,
    irisX:
      base.iris[0] +
      (rig.options.tracking && rig.pointer.inside
        ? clamp((rig.pointer.x - 619) / 250, -1, 1) * 1.25
        : 0),
    irisY: base.iris[1],
  };
}
export function mouthShape(rig) {
  const base = rig.manifest.faceRig.mouth,
    w = rig.getEmotionWeights();
  const opening = clamp(rig.mouthOpening.value, 0, 1.1),
    round = clamp(rig.mouthRound.value, 0, 1);
  const width = base.width * clamp(rig.mouthWidth.value, 0.35, 1.15);
  if (base.upper) {
    const upper = [],
      lower = [];
    for (let i = 0; i < base.upper.length; i++) {
      const closed = base.closed[i] - w.annoyed * base.crease[i] * 3;
      const gap = base.lower[i] - base.upper[i];
      const top = mix(base.upper[i], base.closed[i] - gap * 0.52, round);
      upper.push(mix(closed, top, opening));
      lower.push(upper[i] + gap * opening * (1 + round * 0.13));
    }
    const middle = Math.floor(base.upper.length / 2),
      referenceCentre = (base.upper[middle] + base.lower[middle]) * 0.5,
      currentCentre = (upper[middle] + lower[middle]) * 0.5;
    return {
      ...base,
      y: base.y + referenceCentre - currentCentre,
      x: base.x + (base.width - width) / 2,
      width,
      upper,
      lower,
      opening,
      round,
      id: "mouth",
    };
  }
  const closed = 2.1 - 4.2 * w.annoyed;
  const top = mix(closed, base.top, opening) - round * opening * 5.5;
  const gap = mix(base.bottom - base.top, 18, round) * opening;
  return {
    x: base.x + (base.width - width) / 2,
    y: base.y - w.happy * 0.5,
    width,
    slope: mix(base.slope, 0, round),
    top,
    bottom: top + gap,
    opening,
    round,
  };
}
export function apertureMask(rig, shape) {
  const angle = rig.head.value + (rig.manifest.faceRig.head?.angle || 0);
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const world = rig.headTransform(...faceWorld(rig, shape.x, shape.y));
  const mask = {
    origin: [
      world[0] * rig.scale + rig.offset[0],
      world[1] * rig.scale + rig.offset[1],
    ],
    u: [c / (rig.scale * shape.width), s / (rig.scale * shape.width)],
    v: [-s / rig.scale, c / rig.scale],
    curve: [
      shape.slope || 0,
      shape.upper ? profile(shape.upper, 0.5) : shape.top,
      shape.lower ? profile(shape.lower, 0.5) : shape.bottom,
      0.6 / (rig.scale * (devicePixelRatio || 1)),
    ],
  };
  if (shape.upper) {
    const data = new Uint8Array(shape.upper.length * 4);
    for (let i = 0; i < shape.upper.length; i++) {
      const top = clamp(Math.round(shape.upper[i] * 512 + 32768), 0, 65535),
        bottom = clamp(Math.round(shape.lower[i] * 512 + 32768), 0, 65535);
      data[i * 4] = top >> 8;
      data[i * 4 + 1] = top & 255;
      data[i * 4 + 2] = bottom >> 8;
      data[i * 4 + 3] = bottom & 255;
    }
    mask.profile = { id: shape.id, data, width: shape.upper.length };
  }
  return mask;
}

export function browPoint(rig, side, x, y) {
  const base = rig.manifest.faceRig.eyes[side].brow,
    w = rig.getEmotionWeights();
  const sign = side === "left" ? 1 : -1,
    angle = sign * (w.annoyed * 0.1 - w.surprised * 0.04);
  const point = rotate(x, y, ...base.pivot, angle);
  point[1] += w.annoyed * 0.8 - w.surprised * 2 + w.sleepy * 0.5;
  return faceWorld(rig, ...point);
}
