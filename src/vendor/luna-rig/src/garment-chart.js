import { poseInterval } from "./pose-art.js";
import { rotate } from "./math.js";
import { cuffInverse, cuffForward } from "./cuff-chart.js";

// Every depth pass samples ONE complete painting through ONE positive frame.
// Painted folds supply the hanging shape; the chart only registers seams.
export function garmentFrame(chart, pose) {
  const keys = chart.poses.map((pose) => ({ pose })),
    [i, t] = poseInterval(keys, pose),
    span = chart.poses[i + 1] - chart.poses[i],
    before = Math.max(0, i - 1),
    after = Math.min(keys.length - 1, i + 2);
  const curve = (read) => {
    const a = read(i), b = read(i + 1),
      va = ((b - read(before)) / (keys[i + 1].pose - keys[before].pose)) * span,
      vb = ((read(after) - a) / (keys[after].pose - keys[i].pose)) * span;
    return (2*t**3-3*t*t+1)*a+(t**3-2*t*t+t)*va+(-2*t**3+3*t*t)*b+(t**3-t*t)*vb;
  };
  const a = chart.articulation,
    turn = (a.upperAngles[1] - a.upperAngles[0]) * pose,
    centre = rotate(...chart.sewnRoot, ...a.shoulder, turn),
    radius = Math.max(12, curve((j) => chart.garment[j].radius));
  return { centre, angle: curve((j) => chart.garment[j].angle), radii: [radius, radius] };
}

export function garmentCoordinates(sprite, u, v) {
  const [x, y, w, h] = sprite.rect,
    mirror = sprite.materialChart.mirror || 0,
    p = [x + u*w, y + v*h];
  if (mirror) p[0] = mirror-p[0];
  const q = cuffInverse(p, sprite.garmentCurrent);
  return [sprite.garmentFirst, sprite.garmentSecond].map((frame) => {
    const point = cuffForward(q, frame);
    if (mirror) point[0] = mirror-point[0];
    return [(point[0]-x)/w,(point[1]-y)/h];
  });
}
