import { poseInterval } from "./pose-art.js";
import { smoothstep } from "./math.js";
import { articulatedFrame } from "./arm-articulation.js";

/** Shared positive frame for the entire rolled cuff and both depth passes. */
export function cuffChartParameters(chart, pose) {
  const keys = chart.poses.map((pose) => ({ pose })),
    [i, t] = poseInterval(keys, pose),
    before = Math.max(0, i - 1),
    after = Math.min(keys.length - 1, i + 2),
    span = keys[i + 1].pose - keys[i].pose;
  const curve = (read) => {
    const a = read(i),
      b = read(i + 1),
      va = ((b - read(before)) / (keys[i + 1].pose - keys[before].pose)) * span,
      vb = ((read(after) - a) / (keys[after].pose - keys[i].pose)) * span;
    return (
      (2 * t ** 3 - 3 * t * t + 1) * a +
      (t ** 3 - 2 * t * t + t) * va +
      (-2 * t ** 3 + 3 * t * t) * b +
      (t ** 3 - t * t) * vb
    );
  };
  const physical = chart.articulation ? articulatedFrame(chart.articulation, pose) : null,
    elbow = physical?.elbow || chart.elbow,
    bone = physical?.angle ?? chart.angles[0] + (chart.angles[1] - chart.angles[0]) * pose,
    c = Math.cos(bone),
    s = Math.sin(bone),
    length = curve((j) => chart.cuffLengths[j]),
    along = curve((j) => chart.frames[j].offset[0]),
    across = curve((j) => chart.frames[j].offset[1]),
    centre = [
      elbow[0] + c * (length + along) - s * across,
      elbow[1] + s * (length + along) + c * across,
    ],
    angle = curve((j) => chart.frames[j].angle),
    rx = Math.max(
      8,
      curve((j) => chart.frames[j].radii[0]),
    ),
    ry = Math.max(
      8,
      curve((j) => chart.frames[j].radii[1]),
    );
  return { centre, angle, radii: [rx, ry] };
}

export function cuffForward(point, frame) {
  const c = Math.cos(frame.angle),
    s = Math.sin(frame.angle),
    x = point[0] * frame.radii[0],
    y = point[1] * frame.radii[1];
  return [frame.centre[0] + x * c - y * s, frame.centre[1] + x * s + y * c];
}
export function cuffInverse(point, frame) {
  const c = Math.cos(frame.angle),
    s = Math.sin(frame.angle),
    x = point[0] - frame.centre[0],
    y = point[1] - frame.centre[1];
  return [(x * c + y * s) / frame.radii[0], (-x * s + y * c) / frame.radii[1]];
}

export function cuffMatrix(frame, inverse = false) {
  const c = Math.cos(frame.angle),
    s = Math.sin(frame.angle),
    [rx, ry] = frame.radii,
    [x, y] = frame.centre;
  return inverse
    ? [
        c / rx,
        -s / ry,
        0,
        s / rx,
        c / ry,
        0,
        -(c * x + s * y) / rx,
        (s * x - c * y) / ry,
        1,
      ]
    : [c * rx, s * rx, 0, -s * ry, c * ry, 0, x, y, 1];
}

export function cuffMaterialCoordinates(sprite, u, v) {
  const [x, y, w, h] = sprite.rect,
    mirror = sprite.materialChart.mirror || 0,
    point = [x + u * w, y + v * h];
  if (mirror) point[0] = mirror - point[0];
  const q = cuffInverse(point, sprite.cuffCurrent);
  return [sprite.cuffFirst, sprite.cuffSecond].map((frame) => {
    const p = cuffForward(q, frame);
    if (mirror) p[0] = mirror - p[0];
    return [(p[0] - x) / w, (p[1] - y) / h];
  });
}

export function forearmMouthCoverage(sprite, u, v) {
  const mouth = sprite.forearmMouth;
  if (!mouth) return 1;
  const { frame, cuff, exit } = mouth,
    c = Math.cos(frame.angle),
    s = Math.sin(frame.angle),
    along = v * frame.length,
    across = (u - 0.5) * frame.width,
    point = [
      frame.origin[0] + along * c - across * s,
      frame.origin[1] + along * s + across * c,
    ],
    q = cuffInverse(point, cuff);
  return Math.max(
    1 - smoothstep(0.82, 0.91, Math.hypot(...q)),
    smoothstep(exit - 3, exit + 3, along),
  );
}
