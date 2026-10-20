import { mix, smoothstep, rotate } from "./math.js";
import { upperArmPoint, forearmFrame } from "./hand-rig.js";
import { cuffChartParameters, cuffInverse } from "./cuff-chart.js";
import { samplePoseArt } from "./pose-art.js";

/** The opening and sewn root are attachments, not free fabric particles.
 * Coordinates here describe the current painted pose, before body transforms.
 */
export function sleeveBinding(context) {
  if (context.cachedSleeveBinding) return context.cachedSleeveBinding;
  const prefix =
      context.prefix || (context.manifest.mirror ? "arm-right" : "arm"),
    chart = context.manifest.parts?.[prefix + "-cuff-front"]?.materialChart;
  if (chart?.kind !== "cuff") return null;
  let cuff = context.clothOpening;
  if (!cuff) {
    cuff = cuffChartParameters(chart, context.pose);
    const offset = forearmFrame(context).waveOffset || 0;
    cuff.centre = rotate(
      ...cuff.centre,
      ...samplePoseArt(context).elbow,
      offset,
    );
    cuff.angle += offset;
  }
  return (context.cachedSleeveBinding = {
    root: upperArmPoint(
      context,
      ...(context.manifest.mirror ? [479, 494] : [480, 496]),
    ),
    cuff,
  });
}

export function sleeveFreedom(context, x, y) {
  const binding = sleeveBinding(context);
  if (!binding) return null;
  const fromRoot = Math.hypot(x - binding.root[0], y - binding.root[1]),
    fromOpening = Math.hypot(...cuffInverse([x, y], binding.cuff));
  return smoothstep(18, 84, fromRoot) * smoothstep(1.35, 2.15, fromOpening);
}

/** The top of the flounce is sewn to the upper panel; its scalloped skirt
 * folds with the elbow. Rotating the whole flounce as a rigid plate left a
 * horizontal shelf above the hanging bell throughout the greeting.
 */
export function sleeveFrillPoint(context, x, y) {
  const point = upperArmPoint(context, x, y),
    anatomy = context.manifest.forearmArc;
  if (!anatomy?.upperAngles) return drapePoint(context, ...point);
  const root = upperArmPoint(
      context,
      ...(context.manifest.mirror ? [479, 494] : [480, 496]),
    ),
    bend =
      (anatomy.angles[1] -
        anatomy.angles[0] -
        (anatomy.upperAngles[1] - anatomy.upperAngles[0])) *
      context.pose,
    free = smoothstep(480, 519, y),
    folded = rotate(...point, ...root, bend * 0.12 * free);
  return drapePoint(context, ...folded);
}

// Positive projective charts fitted to the actual asymmetric seated bells.
// Raised landmarks: seam (513,539),(487,561); cuff (391,492),(491,386).
// Polar interpolation retains orientation and volume throughout the lift.
const charts = {
  left: {
    origin: [20.4595614588, 49.8281103434],
    perspective: [-0.004027416394, -0.000399528355],
    stretch: [0.569789202864, -0.3464370196, 0.795163507749],
    angle: 2.492965378983,
  },
  right: {
    origin: [25.4972611541, 39.3355596691],
    perspective: [-0.001333166323, -0.000322640368],
    stretch: [0.566888121329, -0.077047206348, 0.686879735924],
    angle: 2.579096100557,
  },
};

export function drapePoint(context, x, y) {
  if (context.manifest.poseArt) {
    const freedom = sleeveFreedom(context, x, y);
    if (freedom !== null) {
      const lag =
        context.options?.physics === false ? 0 : context.sleeveLag.value;
      return rotate(
        x,
        y,
        ...sleeveBinding(context).root,
        lag * freedom * 0.34 * smoothstep(0, 0.12, context.pose),
      );
    }
    const attachment = forearmFrame(context).origin;
    const weight = smoothstep(523, 670, y) * smoothstep(0, 0.12, context.pose);
    return rotate(
      x,
      y,
      ...attachment,
      (context.options?.physics === false ? 0 : context.sleeveLag.value) *
        weight *
        0.34,
    );
  }
  if (!context.nativeDrape) {
    const chart =
        context.manifest.posedDrape ||
        charts[context.manifest.mirror ? "right" : "left"],
      t = smoothstep(0, 1, context.pose),
      frame = forearmFrame(context),
      angle = chart.angle * t + (frame.waveOffset || 0) * t,
      bunch =
        1 -
        Math.sin(Math.PI * t) *
          Math.min(
            0.45,
            Math.max(
              0,
              1 - frame.length / context.armModel.forearm.rest.length,
            ),
          );
    const raisedRoot = rotate(
        484,
        500,
        ...(context.manifest.upperArm?.shoulder || [500, 365]),
        context.manifest.upperArm?.waveAngle || 0,
      ),
      movingRoot = upperArmPoint(context, 484, 500);
    context.nativeDrape = {
      chart,
      t,
      bunch,
      root: [
        movingRoot[0] - t * (raisedRoot[0] - 484),
        movingRoot[1] - t * (raisedRoot[1] - 500),
      ],
      c: Math.cos(angle),
      s: Math.sin(angle),
    };
  }
  const { chart, t, bunch, root, c, s } = context.nativeDrape,
    dx = x - 484,
    dy = y - 500,
    scale = 1 + t * (chart.perspective[0] * dx + chart.perspective[1] * dy),
    sx = (mix(1, chart.stretch[0], t) * dx + chart.stretch[1] * t * dy) / scale,
    sy = (chart.stretch[1] * t * dx + mix(1, chart.stretch[2], t) * dy) / scale;
  return [
    root[0] + chart.origin[0] * t + (sx * c - sy * s) * bunch,
    root[1] + chart.origin[1] * t + (sx * s + sy * c) * bunch,
  ];
}

export function clothTurn(context) {
  return smoothstep(0.06, 0.84, context.pose);
}

export function cuffContour(context) {
  const source = cuffContours[context.manifest.mirror ? "right" : "left"],
    raised = context.manifest.posedCuff;
  if (!raised) return source;
  const turn = clothTurn(context);
  return raised.map((p, k) => {
    const u = (k / (raised.length - 1)) * (source.length - 1),
      i = Math.min(source.length - 2, Math.floor(u)),
      q = source[i].map((v, axis) => mix(v, source[i + 1][axis], u - i));
    return p.map((v, axis) => mix(q[axis], v, turn));
  });
}

export const cuffContours = {
  left: [
    [603, 620],
    [598, 633],
    [584, 629],
    [569, 621],
    [555, 620],
    [542, 625],
    [526, 640],
    [507, 654],
    [484, 668],
    [461, 675],
    [440, 682],
    [418, 686],
    [400, 684],
  ],
  right: [
    [607, 633],
    [602, 644],
    [586, 638],
    [572, 627],
    [556, 625],
    [544, 633],
    [528, 640],
    [507, 653],
    [486, 672],
    [465, 690],
    [443, 704],
    [422, 716],
    [403, 717],
    [388, 705],
  ],
};
