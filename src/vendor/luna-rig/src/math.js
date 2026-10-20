export const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
export const mix = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export function rotate(x, y, cx, cy, angle) {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
}

// Damped spring advanced with bounded substeps; stable after long tab suspensions.
export class Spring {
  constructor(value = 0, stiffness = 70, damping = 11) {
    this.value = value;
    this.velocity = 0;
    this.target = value;
    this.stiffness = stiffness;
    this.damping = damping;
  }
  step(dt) {
    let remaining = clamp(dt, 0, 0.1);
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 240);
      this.velocity +=
        ((this.target - this.value) * this.stiffness -
          this.velocity * this.damping) *
        h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    return this.value;
  }
  kick(velocity) {
    this.velocity += velocity;
  }
  reset(value = 0) {
    this.value = this.target = value;
    this.velocity = 0;
  }
}

export function barycentric(px, py, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-8) return null;
  const a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
  const b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
  return a >= 0 && b >= 0 && a + b <= 1 ? [a, b, 1 - a - b] : null;
}

export function armFrame(model, material, pose) {
  const a = model[material].rest,
    b = model[material].wave;
  const interpolateAngle = (a, b) => {
    let delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    // Leaving the lap goes around the outside of the elbow. The shortest 2D
    // angle carries the hand across the brooch and through the upper torso.
    if (model[material].arc === "outward" && delta < 0) delta += Math.PI * 2;
    return a + delta * pose;
  };
  let origin = [
    mix(a.origin[0], b.origin[0], pose),
    mix(a.origin[1], b.origin[1], pose),
  ];
  if (material === "hand") {
    const fa = model.forearm.rest,
      fb = model.forearm.wave;
    const angle = interpolateAngle(fa.angle, fb.angle),
      length =
        mix(fa.length, fb.length, pose) -
        (model.forearm.shortening || 0) * Math.sin(Math.PI * pose);
    origin = [
      mix(fa.origin[0], fb.origin[0], pose) + length * Math.cos(angle),
      mix(fa.origin[1], fb.origin[1], pose) + length * Math.sin(angle),
    ];
  }
  return {
    origin,
    angle: interpolateAngle(a.angle, b.angle),
    width: mix(a.width, b.width, pose),
    start: mix(a.start, b.start, pose),
    length:
      mix(a.length, b.length, pose) -
      (material === "forearm"
        ? a && (model.forearm.shortening || 0) * Math.sin(Math.PI * pose)
        : 0),
  };
}
export function framePoint(frame, u, v) {
  const along = frame.start + v * frame.length,
    across = (u - 0.5) * frame.width;
  return [
    frame.origin[0] +
      along * Math.cos(frame.angle) -
      across * Math.sin(frame.angle),
    frame.origin[1] +
      along * Math.sin(frame.angle) +
      across * Math.cos(frame.angle),
  ];
}
