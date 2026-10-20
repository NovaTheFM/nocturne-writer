import { clamp, smoothstep, rotate } from "./math.js";
import { articulatedFrame } from "./arm-articulation.js";

export function poseInterval(keys, pose) {
  const value = clamp(pose, keys[0].pose, keys.at(-1).pose);
  let index = 0;
  while (index < keys.length - 2 && value > keys[index + 1].pose) index++;
  return [
    index,
    (value - keys[index].pose) / (keys[index + 1].pose - keys[index].pose),
  ];
}

export function samplePoseArt(context) {
  if (context.cachedPoseArt) return context.cachedPoseArt;
  const keys = context.manifest.poseArt,
    [index, t] = poseInterval(keys, context.pose);
  const a = keys[index],
    b = keys[index + 1],
    before = keys[Math.max(0, index - 1)],
    after = keys[Math.min(keys.length - 1, index + 2)];
  const span = b.pose - a.pose;
  const curve = (field, component) => {
    const read = (key) =>
      component === undefined ? key[field] : key[field][component];
    const u = read(a),
      v = read(b),
      va = ((v - read(before)) / (b.pose - before.pose)) * span,
      vb = ((read(after) - u) / (after.pose - a.pose)) * span;
    return (
      (2 * t ** 3 - 3 * t * t + 1) * u +
      (t ** 3 - 2 * t * t + t) * va +
      (-2 * t ** 3 + 3 * t * t) * v +
      (t ** 3 - t * t) * vb
    );
  };
  const result = {
    wrist: [curve("wrist", 0), curve("wrist", 1)],
    elbow: [curve("elbow", 0), curve("elbow", 1)],
    cuff: [curve("cuff", 0), curve("cuff", 1)],
    handAngle: curve("handAngle"),
  };
  const anatomy = context.manifest.forearmArc;
  if (anatomy) {
    const physical = articulatedFrame(anatomy, context.pose),
      angle = physical.angle,
      c = Math.cos(angle),
      s = Math.sin(angle),
      readCuff = (key) => {
        const a =
            anatomy.angles[0] +
            (anatomy.angles[1] - anatomy.angles[0]) * key.pose,
          elbow = articulatedFrame(anatomy, key.pose).elbow,
          dx = key.cuff[0] - elbow[0],
          dy = key.cuff[1] - elbow[1];
        return [
          dx * Math.cos(a) + dy * Math.sin(a),
          -dx * Math.sin(a) + dy * Math.cos(a),
        ];
      },
      localKeys = keys.map((key) => ({ ...key, cuff: readCuff(key) }));
    const localCurve = (component) => {
      const u = localKeys[index].cuff[component],
        v = localKeys[index + 1].cuff[component],
        first = localKeys[Math.max(0, index - 1)].cuff[component],
        last = localKeys[Math.min(keys.length - 1, index + 2)].cuff[component],
        va = ((v - first) / (b.pose - before.pose)) * span,
        vb = ((last - u) / (after.pose - a.pose)) * span;
      return (
        (2 * t ** 3 - 3 * t * t + 1) * u +
        (t ** 3 - 2 * t * t + t) * va +
        (-2 * t ** 3 + 3 * t * t) * v +
        (t ** 3 - t * t) * vb
      );
    };
    const along = localCurve(0),
      across = localCurve(1);
    result.elbow = physical.elbow;
    result.wrist = physical.wrist;
    result.cuff = [
      physical.elbow[0] + c * along - s * across,
      physical.elbow[1] + s * along + c * across,
    ];
    result.handAngle =
      keys[0].handAngle +
      (keys.at(-1).handAngle - keys[0].handAngle) * clamp(context.pose, 0, 1);
  }
  return result;
}

/** Secondary motion on the articulated skin, independent from sleeve cloth. */
export function poseSkinPoint(context, x, y) {
  const art = samplePoseArt(context),
    amount = context.pose ** 2 * context.waveGesture.value;
  const forearm = Math.sin(context.time * 6.2) * 0.012 * amount;
  const wrist = Math.sin(context.time * 6.2 + 0.35) * 0.065 * amount;
  const along =
    (x - art.wrist[0]) * Math.cos(art.handAngle) +
    (y - art.wrist[1]) * Math.sin(art.handAngle);
  let p = rotate(x, y, ...art.wrist, wrist * smoothstep(-14, 6, along));
  return rotate(...p, ...art.elbow, forearm);
}

/** Paint stays in a wrist-local chart. A sleeve cuff never deforms fingers. */
export function poseHandPoint(context, x, y) {
  const art = samplePoseArt(context),
    source = context.manifest.poseArt[0],
    amount = context.pose ** 2 * context.waveGesture.value,
    forearm = Math.sin(context.time * 6.2) * 0.012 * amount,
    wrist = Math.sin(context.time * 6.2 + 0.35) * 0.065 * amount;
  const delta = rotate(
    x - source.wrist[0],
    y - source.wrist[1],
    0,
    0,
    art.handAngle - source.handAngle + wrist,
  );
  return rotate(
    art.wrist[0] + delta[0],
    art.wrist[1] + delta[1],
    ...art.elbow,
    forearm,
  );
}
