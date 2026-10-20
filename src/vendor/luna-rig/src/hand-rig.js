import {
  armFrame,
  clamp,
  mix,
  smoothstep,
  rotate,
  framePoint,
} from "./math.js";
import { samplePoseArt } from "./pose-art.js";

export function upperArmAngle(rig) {
  const articulation = rig.manifest.forearmArc;
  if (articulation?.upperAngles)
    return (articulation.upperAngles[1] - articulation.upperAngles[0]) * clamp(rig.pose, 0, 1);
  return rig.manifest.upperArm
    ? (rig.manifest.upperArm.waveAngle || 0) * smoothstep(0, 1, rig.pose) +
        rig.manifest.upperArm.excursion * Math.sin(Math.PI * rig.pose)
    : 0;
}
export function upperArmPoint(rig, x, y) {
  const shoulder = rig.manifest.upperArm?.shoulder || [500, 365];
  return rotate(x, y, ...shoulder, upperArmAngle(rig));
}
export function upperSleevePoint(rig, u, v) {
  const frame = rig.manifest.upperArm.frame;
  return upperArmPoint(rig, ...framePoint(frame, u, v));
}

export function forearmFrame(rig) {
  if (rig.cachedForearmFrame) return rig.cachedForearmFrame;
  if (rig.manifest.poseArt) {
    const art = samplePoseArt(rig),
      delta = art.wrist.map((v, i) => v - art.elbow[i]);
    const offset =
      Math.sin(rig.time * 6.2) * 0.012 * rig.pose ** 2 * rig.waveGesture.value;
    return {
      origin: art.elbow,
      angle: Math.atan2(delta[1], delta[0]) + offset,
      length: Math.hypot(...delta),
      width: 110,
      start: 0,
      nativeJoint: true,
      waveOffset: offset,
    };
  }
  if (rig.manifest.referenceAssembly) {
    const source = rig.armModel.forearm.rest,
      target = rig.armModel.hand.wave,
      restWrist = [
        source.origin[0] + source.length * Math.cos(source.angle),
        source.origin[1] + source.length * Math.sin(source.angle),
      ],
      t = rig.pose,
      a = 1 - t;
    const wrist = [
      a * a * a * restWrist[0] +
        3 * a * a * t * (source.origin[0] - 115) +
        3 * a * t * t * (source.origin[0] - 145) +
        t * t * t * target.origin[0],
      a * a * a * restWrist[1] +
        3 * a * a * t * (restWrist[1] + 14) +
        3 * a * t * t * (target.origin[1] - 13) +
        t * t * t * target.origin[1],
    ];
    const origin = upperArmPoint(rig, ...source.origin),
      angle = Math.atan2(wrist[1] - origin[1], wrist[0] - origin[0]),
      waveOffset =
        Math.sin(rig.time * 6.2) * 0.025 * t * t * rig.waveGesture.value;
    return {
      origin,
      angle: angle + waveOffset,
      length: Math.hypot(wrist[0] - origin[0], wrist[1] - origin[1]),
      width: source.width,
      start: 0,
      nativeJoint: true,
      waveOffset,
    };
  }
  const frame = armFrame(rig.armModel, "forearm", rig.pose);
  frame.origin = upperArmPoint(rig, ...frame.origin);
  frame.angle +=
    Math.sin(rig.time * 6.2) * 0.025 * rig.pose ** 2 * rig.waveGesture.value;
  return frame;
}
export function handFrame(rig) {
  if (rig.cachedHandFrame) return rig.cachedHandFrame;
  if (rig.manifest.poseArt) {
    const art = samplePoseArt(rig),
      forearm = forearmFrame(rig);
    return {
      origin: rotate(...art.wrist, ...art.elbow, forearm.waveOffset),
      angle:
        art.handAngle +
        forearm.waveOffset +
        Math.sin(rig.time * 6.2 + 0.35) *
          0.065 *
          rig.pose ** 2 *
          rig.waveGesture.value,
      length: 54,
      width: 52,
    };
  }
  const forearm = forearmFrame(rig),
    model = rig.manifest.handRig.palm;
  const base = armFrame(rig.armModel, "hand", rig.pose);
  const gesture = forearm.nativeJoint
    ? forearm.waveOffset
    : forearm.angle - armFrame(rig.armModel, "forearm", rig.pose).angle;
  let nativeAngle;
  if (forearm.nativeJoint) {
    const source = rig.armModel.forearm.rest,
      target = rig.armModel.hand.wave,
      raisedElbow = rotate(
        ...source.origin,
        ...(rig.manifest.upperArm?.shoulder || [500, 365]),
        rig.manifest.upperArm?.waveAngle || 0,
      ),
      raisedForearm = Math.atan2(
        target.origin[1] - raisedElbow[1],
        target.origin[0] - raisedElbow[0],
      ),
      restBend = rig.armModel.hand.rest.angle - source.angle,
      raisedBend = target.angle - raisedForearm;
    // The forearm swings outward through +pi, while the old independent
    // hand angle interpolated in the opposite direction. That bent the wrist
    // backwards and opened a rectangular gap in the intermediate poses.
    nativeAngle =
      forearm.angle + mix(restBend, raisedBend, smoothstep(0, 1, rig.pose));
  }
  return {
    origin: [
      forearm.origin[0] + forearm.length * Math.cos(forearm.angle),
      forearm.origin[1] + forearm.length * Math.sin(forearm.angle),
    ],
    angle:
      (nativeAngle ?? base.angle + gesture) +
      Math.sin(rig.time * 6.2 + 0.35) *
        0.09 *
        rig.pose ** 2 *
        rig.waveGesture.value,
    length: mix(model.restLength, model.waveLength, rig.pose),
    width: mix(model.restWidth, model.waveWidth, rig.pose),
  };
}

/** Limit motion in anatomical space, where the wrist path bends sharply.
 * A pose spring alone can turn the hand by ninety degrees in four frames.
 * This also bounds the return and variable-frame-rate playback.
 */
export function limitArmPose(rig, previous, proposed, dt) {
  if (!(dt > 0) || previous === proposed) return previous;
  const at = (pose) =>
    handFrame({
      ...rig,
      pose,
      time: rig.time || 0,
      cachedForearmFrame: null,
      cachedHandFrame: null,
      cachedPoseArt: null,
      waveGesture: { value: 0 },
    });
  const source = at(previous),
    maxAngle = 3.8 * dt,
    maxDistance = 350 * dt;
  const admissible = (pose) => {
    const candidate = at(pose),
      angle = candidate.angle - source.angle;
    return (
      Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) <= maxAngle &&
      Math.hypot(
        candidate.origin[0] - source.origin[0],
        candidate.origin[1] - source.origin[1],
      ) <= maxDistance
    );
  };
  if (admissible(proposed)) return proposed;
  let low = 0,
    high = 1;
  for (let i = 0; i < 10; i++) {
    const middle = (low + high) / 2;
    if (admissible(mix(previous, proposed, middle))) low = middle;
    else high = middle;
  }
  return mix(previous, proposed, low);
}
function localPoint(frame, along, across) {
  const c = frame.cosine ?? Math.cos(frame.angle),
    s = frame.sine ?? Math.sin(frame.angle);
  return [
    frame.origin[0] + along * c - across * s,
    frame.origin[1] + along * s + across * c,
  ];
}
export function handTurn(rig) {
  return smoothstep(0.25, 0.8, rig.pose);
}
function rollPoint(rig, frame, point) {
  const turn = handTurn(rig),
    // A modest wrist yaw keeps finger volume through the transition. A full
    // planar half-turn collapses five coplanar strips into a red comb.
    projection = 1 - 0.12 * Math.sin(Math.PI * turn),
    c = frame.cosine ?? Math.cos(frame.angle),
    s = frame.sine ?? Math.sin(frame.angle),
    x = point[0] - frame.origin[0],
    y = point[1] - frame.origin[1],
    along = x * c + y * s,
    across = -x * s + y * c,
    // The wrist is a round joint. The palm and all five fingers turn as one
    // volume, rather than dissolving between broad front and back paintings.
    width = mix(1, projection, smoothstep(0.05, 0.5, along / frame.length));
  return localPoint(frame, along, across * width);
}
export function palmPoint(rig, u, v) {
  const frame = handFrame(rig);
  const point = localPoint(
    frame,
    frame.length * v - 9 * (1 - v),
    (u - 0.5) * frame.width,
  );
  return rollPoint(rig, frame, point);
}
export function fingerPoint(rig, name, u, v) {
  const description = rig.manifest.handRig.fingers[name],
    frame = handFrame(rig);
  const rest = rig.armModel.hand.rest,
    restPalm = rig.manifest.handRig.palm;
  const restFrame = { origin: rest.origin, angle: rest.angle };
  const restRoot = localPoint(
    restFrame,
    (description.restAlong ?? description.along) * restPalm.restLength,
    (description.restCross ?? description.cross) * restPalm.restWidth,
  );
  const delta = [
    description.restTip[0] - restRoot[0],
    description.restTip[1] - restRoot[1],
  ];
  const restAngle = Math.atan2(delta[1], delta[0]) - rest.angle,
    restLength = Math.hypot(...delta);
  // The hand opens after clearing the dress, with each digit retaining its own
  // root, length and bend. Texture contours never interpolate into another hand.
  const opening = handTurn(rig);
  const angle = frame.angle + mix(restAngle, description.waveAngle, opening);
  const length = mix(restLength, description.waveLength, opening);
  const root = localPoint(
    frame,
    mix(
      description.restAlong ?? description.along,
      description.along,
      opening,
    ) * frame.length,
    mix(
      description.restCross ?? description.cross,
      description.cross,
      opening,
    ) * frame.width,
  );
  const curl = (1 - opening) * (name === "thumb" ? 0.055 : 0.07);
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const bend = length * curl * 4 * v * (1 - v),
    along = length * v;
  const tangent = curl * 4 * (1 - 2 * v),
    normalLength = Math.hypot(1, tangent);
  const normal = [
    (-s - c * tangent) / normalLength,
    (c - s * tangent) / normalLength,
  ];
  const width = mix(
      description.width * 0.84,
      description.waveWidth || description.width,
      opening,
    ),
    across = (u - 0.5) * width;
  return rollPoint(rig, frame, [
    root[0] + along * c - bend * s + across * normal[0],
    root[1] + along * s + bend * c + across * normal[1],
  ]);
}
export function handFacing(rig) {
  return 1 - handTurn(rig);
}
