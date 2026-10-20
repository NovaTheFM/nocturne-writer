import { clamp } from "./math.js";

// The last edge is the fabric attachment inside the pompom, not a cord.
const REST = [
  [671, 67],
  [718, 48],
  [767, 86],
  [797, 142],
  [813, 190],
  [820, 220],
];
const PINS = [
  [499, 89],
  [533, 68],
  [577, 82],
  [621, 109],
  [669, 144],
  [708, 183],
  [744, 210],
];
const MASS = [0, 0.65, 0.8, 0.7, 0.5, 1.45];
const TETHER = [0, 160, 110, 72, 46, 9];
const length = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Small constrained cloth cage. Inertia and pompom load share every edge. */
export class HatPhysics {
  constructor() {
    this.reset();
  }
  reset() {
    this.points = REST.map((p) => [...p]);
    this.velocity = REST.map(() => [0, 0]);
    this.brim = [0, 0];
  }
  snapshot() {
    return {
      points: this.points.map((p) => [...p]),
      velocity: this.velocity.map((v) => [...v]),
      brim: [...this.brim],
    };
  }
  restore(state) {
    this.points = state.points.map((p) => [...p]);
    this.velocity = state.velocity.map((v) => [...v]);
    this.brim = [...state.brim];
  }
  kick(x, y) {
    this.velocity[5][0] += x;
    this.velocity[5][1] += y;
    for (let i = 1; i < 5; i++) {
      this.velocity[i][0] += x * i * 0.055;
      this.velocity[i][1] += y * i * 0.055;
    }
  }
  step(dt, { drag = null, wind = 0, inertia = 0, enabled = true } = {}) {
    if (dt <= 0) return;
    const substeps = Math.max(1, Math.ceil(Math.min(dt, 0.1) * 240)),
      h = Math.min(dt, 0.1) / substeps;
    let target = null;
    if (drag) {
      const dx = drag[0] - REST[5][0],
        dy = drag[1] - REST[5][1],
        bound = Math.min(1, 62 / Math.max(1, Math.hypot(dx, dy)));
      target = [REST[5][0] + dx * bound, REST[5][1] + dy * bound];
    }
    for (let step = 0; step < substeps; step++) {
      const old = this.points.map((p) => [...p]);
      for (let i = 1; i < 6; i++) {
        const p = this.points[i],
          v = this.velocity[i],
          rest = REST[i];
        const k = TETHER[i] * (enabled ? 1 : 2);
        v[0] +=
          ((k * (rest[0] - p[0])) / MASS[i] +
            (enabled ? wind * i * 7 + inertia * i * 1.7 : 0)) *
          h;
        v[1] += ((k * (rest[1] - p[1])) / MASS[i]) * h;
        if (i === 5 && target) {
          v[0] += (target[0] - p[0]) * 850 * h;
          v[1] += (target[1] - p[1]) * 850 * h;
        }
        const damping = Math.exp(-7 * h);
        v[0] *= damping;
        v[1] *= damping;
        p[0] += v[0] * h;
        p[1] += v[1] * h;
      }
      // Constraints pass the pompom's load back through the whole fabric.
      for (let iteration = 0; iteration < 6; iteration++) {
        for (let i = 4; i >= 0; i--) {
          const a = this.points[i],
            b = this.points[i + 1],
            dx = b[0] - a[0],
            dy = b[1] - a[1],
            d = Math.max(0.001, Math.hypot(dx, dy));
          const rest = length(REST[i], REST[i + 1]);
          const stretch = i === 4 ? 1 : 1.015;
          const wanted = clamp(d, rest / stretch, rest * stretch),
            error = (d - wanted) / d;
          const wa = i ? 1 / MASS[i] : 0,
            wb = 1 / MASS[i + 1],
            sum = wa + wb;
          a[0] += (dx * error * wa) / sum;
          a[1] += (dy * error * wa) / sum;
          b[0] -= (dx * error * wb) / sum;
          b[1] -= (dy * error * wb) / sum;
        }
        // Bend resistance couples neighbouring fabric sections. Without it
        // the last attachment can fold back freely like a dangling cord.
        for (let i = 3; i >= 0; i--) {
          const a = this.points[i],
            b = this.points[i + 2],
            dx = b[0] - a[0],
            dy = b[1] - a[1],
            d = Math.max(0.001, Math.hypot(dx, dy));
          const rest = length(REST[i], REST[i + 2]),
            wanted = clamp(d, rest * 0.92, rest * 1.08),
            error = ((d - wanted) / d) * 0.55;
          const wa = i ? 1 / MASS[i] : 0,
            wb = 1 / MASS[i + 2],
            sum = wa + wb;
          a[0] += (dx * error * wa) / sum;
          a[1] += (dy * error * wa) / sum;
          b[0] -= (dx * error * wb) / sum;
          b[1] -= (dy * error * wb) / sum;
        }
        this.points[0] = [...REST[0]];
      }
      const tip = this.points[4],
        pom = this.points[5],
        dx = pom[0] - tip[0],
        dy = pom[1] - tip[1],
        d = Math.max(0.001, Math.hypot(dx, dy)),
        attachment = Math.hypot(7, 30);
      pom[0] = tip[0] + (dx / d) * attachment;
      pom[1] = tip[1] + (dy / d) * attachment;
      for (let i = 1; i < 6; i++)
        for (let axis = 0; axis < 2; axis++)
          this.velocity[i][axis] = clamp(
            (this.points[i][axis] - old[i][axis]) / h,
            -900,
            900,
          );
    }
    const load = [
      this.points[5][0] - REST[5][0],
      this.points[5][1] - REST[5][1],
    ];
    this.brim = load.map((n) => clamp(n * 0.035, -2.2, 2.2));
  }
  point(x, y) {
    const controls = [...REST, ...PINS],
      offsets = REST.map((p, i) => [
        this.points[i][0] - p[0],
        this.points[i][1] - p[1],
      ]);
    for (const p of PINS) offsets.push([...this.brim]);
    let total = 0,
      dx = 0,
      dy = 0;
    for (let i = 0; i < controls.length; i++) {
      const d = (x - controls[i][0]) ** 2 + (y - controls[i][1]) ** 2;
      if (d < 0.0001) return [x + offsets[i][0], y + offsets[i][1]];
      const weight = 1 / (d + 1);
      total += weight;
      dx += offsets[i][0] * weight;
      dy += offsets[i][1] * weight;
    }
    return [x + dx / total, y + dy / total];
  }
  pompom() {
    return [...this.points[5]];
  }
  pompomAngle() {
    const a = this.points[4],
      b = this.points[5];
    return Math.atan2(b[1] - a[1], b[0] - a[0]) - Math.atan2(30, 7);
  }
  strain() {
    return Math.max(
      ...REST.slice(1).map((p, i) =>
        Math.abs(
          length(this.points[i], this.points[i + 1]) / length(REST[i], p) - 1,
        ),
      ),
    );
  }
}
