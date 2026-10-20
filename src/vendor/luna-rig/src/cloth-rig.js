import { framePoint, armFrame, smoothstep, mix } from "./math.js";
import { forearmFrame, upperArmPoint } from "./hand-rig.js";

/** A sleeve has a pinned upper seam, a forearm-bound cuff and hanging cloth.
 * The free hem folds across the arm as it rises; it does not remain a second
 * long skirt below the elbow. One continuous field keeps all three connected.
 */
export function coatPoint(rig, u, v) {
  const surface = rig.manifest.sleeveRig?.surface;
  if (surface) return surfacePoint(rig, surface, u, v);
  const rest = framePoint(armFrame(rig.armModel, "coat", 0), u, v);
  const source = rig.armModel.forearm.rest,
    frame = forearmFrame(rig),
    axis = [Math.cos(source.angle), Math.sin(source.angle)],
    normal = [-axis[1], axis[0]],
    dx = rest[0] - source.origin[0],
    dy = rest[1] - source.origin[1],
    along = dx * axis[0] + dy * axis[1],
    across = dx * normal[0] + dy * normal[1];
  const bindings = rig.manifest.sleeveRig?.bindings || [
      [500, 515],
      source.origin,
    ],
    root = bindings[0],
    pin = smoothstep(5, 82, Math.hypot(rest[0] - root[0], rest[1] - root[1]));
  const fold = smoothstep(0.12, 0.92, rig.pose),
    c = Math.cos(frame.angle),
    s = Math.sin(frame.angle),
    width = mix(1, 0.44, fold),
    hanging = Math.max(0, across) * fold * 0.31;
  const following = [
    frame.origin[0] + along * c - across * width * s,
    frame.origin[1] + along * s + across * width * c + hanging,
  ];
  const upper = upperArmPoint(rig, ...rest),
    point = [
      mix(upper[0], following[0], pin),
      mix(upper[1], following[1], pin),
    ];
  const free = Math.min(
      ...bindings.map((p) => Math.hypot(rest[0] - p[0], rest[1] - p[1])),
    ),
    soft = smoothstep(12, 72, free),
    lag = rig.sleeveLag?.value || 0;
  point[0] += lag * free * 0.22 * soft;
  point[1] += Math.abs(lag) * free * 0.09 * soft;
  return point;
}

function sample(points, t) {
  const scaled = t * (points.length - 1),
    i = Math.min(points.length - 2, Math.floor(scaled));
  return [
    mix(points[i][0], points[i + 1][0], scaled - i),
    mix(points[i][1], points[i + 1][1], scaled - i),
  ];
}
function patch(definition, u, v) {
  if (definition.grid) {
    const grid = definition.grid,
      n = grid.length - 1,
      x = u * n,
      y = v * n,
      i = Math.min(n - 1, Math.floor(x)),
      j = Math.min(n - 1, Math.floor(y));
    return [0, 1].map((k) =>
      mix(
        mix(grid[j][i][k], grid[j][i + 1][k], x - i),
        mix(grid[j + 1][i][k], grid[j + 1][i + 1][k], x - i),
        y - j,
      ),
    );
  }
  const r = sample(definition.root, u),
    c = sample(definition.cuff, u),
    a = sample(definition.left, v),
    b = sample(definition.right, v),
    corners = [
      definition.root[0],
      definition.root.at(-1),
      definition.cuff[0],
      definition.cuff.at(-1),
    ];
  return [0, 1].map(
    (k) =>
      (1 - v) * r[k] +
      v * c[k] +
      (1 - u) * a[k] +
      u * b[k] -
      ((1 - v) * ((1 - u) * corners[0][k] + u * corners[1][k]) +
        v * ((1 - u) * corners[2][k] + u * corners[3][k])),
  );
}
function surfacePoint(rig, surface, u, v) {
  const rest = patch(surface.rest, u, v),
    raised = patch(surface.wave, u, v),
    restFrame = rig.armModel.forearm.rest,
    waveFrame = rig.armModel.forearm.wave,
    current = forearmFrame(rig),
    t = smoothstep(0, 1, rig.pose);
  const local = (p, f) => {
    const x = p[0] - f.origin[0],
      y = p[1] - f.origin[1],
      c = Math.cos(f.angle),
      s = Math.sin(f.angle);
    return [x * c + y * s, -x * s + y * c];
  };
  const a = local(rest, restFrame),
    b = local(raised, waveFrame),
    along =
      (mix(a[0], b[0], t) * current.length) /
      mix(restFrame.length, waveFrame.length, rig.pose),
    across = mix(a[1], b[1], t),
    c = Math.cos(current.angle),
    s = Math.sin(current.angle),
    following = [
      current.origin[0] + along * c - across * s,
      current.origin[1] + along * s + across * c,
    ],
    seam = upperArmPoint(
      rig,
      mix(rest[0], raised[0], t),
      mix(rest[1], raised[1], t),
    ),
    follow = smoothstep(0, 0.72, v),
    lag = (rig.sleeveLag?.value || 0) * Math.sin(Math.PI * v) * 6;
  // The loose outer bell hangs from the elbow while the wrist turns. Rotating
  // every vertex with the forearm throws this broad hem sideways like a rigid
  // plate. Keep the wrist-side cuff bound to the arm; let the remote fabric
  // fold downward. Both native endpoint paintings retain their exact geometry.
  const free =
      Math.sin(Math.PI * rig.pose) * smoothstep(30, 125, a[1]) * follow,
    hanging = [
      seam[0],
      Math.max(seam[1], current.origin[1] + Math.max(0, a[1]) * 0.5 * (1 - t)),
    ];
  return [
    mix(mix(seam[0], following[0], follow), hanging[0], free) + lag,
    mix(mix(seam[1], following[1], follow), hanging[1], free),
  ];
}
