import { clamp, smoothstep } from "./math.js";
import { poseInterval } from "./pose-art.js";

/** Monotone axial gathering with a rigid mouth and a hanging cloth bag.
 * Length gathers before the opening; it never scales the rolled cuff. The
 * lower bag shears towards gravity with a positive Jacobian at every pose.
 */
export function clothChartParameters(chart, pose) {
  const keys = chart.poses.map((pose) => ({ pose })),
    [i, t] = poseInterval(keys, pose),
    before = Math.max(0, i - 1),
    after = Math.min(keys.length - 1, i + 2),
    span = chart.poses[i + 1] - chart.poses[i],
    a = chart.cuffLengths[i],
    b = chart.cuffLengths[i + 1],
    va =
      ((b - chart.cuffLengths[before]) /
        (chart.poses[i + 1] - chart.poses[before])) *
      span,
    vb =
      ((chart.cuffLengths[after] - a) / (chart.poses[after] - chart.poses[i])) *
      span,
    cuff =
      (2 * t ** 3 - 3 * t * t + 1) * a +
      (t ** 3 - 2 * t * t + t) * va +
      (-2 * t ** 3 + 3 * t * t) * b +
      (t ** 3 - t * t) * vb,
    angle =
      chart.angles[0] + (chart.angles[1] - chart.angles[0]) * clamp(pose, 0, 1);
  return {
    elbow: chart.elbow,
    angle,
    delta: cuff - chart.radius,
    sourceAngle: chart.sourceAngle,
    radius: chart.radius,
    far: chart.far,
  };
}

function gravityGather(v) {
  const t = clamp((v - 38) / 47, 0, 1);
  return v >= 85 ? v - 61.5 : 47 * (t ** 3 - 0.5 * t ** 4);
}

function invertMonotone(value, low, high, fn, derivative) {
  let x = low + ((high - low) * (value - fn(low))) / (fn(high) - fn(low));
  for (let i = 0; i < 12; i++) {
    const error = fn(x) - value;
    if (Math.abs(error) < 1e-12) break;
    if (error > 0) high = x;
    else low = x;
    const next = x - error / derivative(x);
    x = next > low && next < high ? next : (low + high) / 2;
  }
  return x;
}

export function clothChartForward(point, frame) {
  const c0 = Math.cos(frame.sourceAngle),
    s0 = Math.sin(frame.sourceAngle),
    u = point[0] * c0 + point[1] * s0,
    v = -point[0] * s0 + point[1] * c0,
    c = Math.cos(frame.angle),
    s = Math.sin(frame.angle),
    hanging = gravityGather(v),
    x = u + frame.delta * smoothstep(0, frame.radius - 22, u) + s * hanging,
    y = v + (c - 1) * hanging;
  return [frame.elbow[0] + x * c - y * s, frame.elbow[1] + x * s + y * c];
}

export function clothChartInverse(point, frame) {
  const c = Math.cos(frame.angle),
    s = Math.sin(frame.angle),
    dx = point[0] - frame.elbow[0],
    dy = point[1] - frame.elbow[1],
    x = dx * c + dy * s,
    y = -dx * s + dy * c,
    gravity = (v) => v + (c - 1) * gravityGather(v),
    v =
      y <= 38
        ? y
        : y >= gravity(85)
          ? (y - (1 - c) * 61.5) / c
          : invertMonotone(
              y,
              38,
              85,
              gravity,
              (v) => 1 + (c - 1) * smoothstep(38, 85, v),
            ),
    a = x - s * gravityGather(v),
    limit = frame.radius - 22,
    gather = (u) => u + frame.delta * smoothstep(0, limit, u),
    u =
      a <= 0
        ? a
        : a >= limit + frame.delta
          ? a - frame.delta
          : invertMonotone(a, 0, limit, gather, (u) => {
              const t = u / limit;
              return 1 + (frame.delta * 6 * t * (1 - t)) / limit;
            }),
    c0 = Math.cos(frame.sourceAngle),
    s0 = Math.sin(frame.sourceAngle);
  return [u * c0 - v * s0, u * s0 + v * c0];
}

export function clothMaterialCoordinates(sprite, u, v) {
  const current = sprite.clothCurrent,
    a = sprite.clothFirst,
    b = sprite.clothSecond,
    [x, y, w, h] = sprite.rect,
    point = [x + u * w, y + v * h],
    mirror = sprite.materialChart.mirror || 0;
  if (mirror) point[0] = mirror - point[0];
  const canonical = clothChartInverse(point, current);
  return [a, b].map((frame) => {
    const p = clothChartForward(canonical, frame);
    if (mirror) p[0] = mirror - p[0];
    return [(p[0] - x) / w, (p[1] - y) / h];
  });
}
