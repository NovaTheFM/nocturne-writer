import { Spring, clamp, mix, rotate, smoothstep } from "./math.js";

const REST = {
  "back-left": { root: [520, 210], end: 735 },
  "back-right": { root: [704, 195], end: 745 },
  "front-left": { root: [543, 280], end: 514 },
  "front-right": { root: [676, 250], end: 554 },
};

/** The scalp binds instantly; the hanging mass follows translation with lag.
 * Head rotation fades down the strand, rather than rotating its entire length.
 */
export class HairChain {
  constructor(name) {
    this.definition = REST[name];
    this.front = name.startsWith("front");
    const frequency = this.front ? [48, 32, 22] : [35, 23, 16];
    this.x = frequency.map((k, i) => new Spring(0, k, 9 - i * 0.8));
    this.y = frequency.map((k, i) => new Spring(0, k * 1.2, 11 - i));
  }
  reset() {
    for (const spring of [...this.x, ...this.y]) spring.reset();
  }
  step(rig, dt, gust) {
    const root = this.definition.root,
      p = rig.headTransform(...root),
      delta = [p[0] - root[0], p[1] - root[1]];
    if (!rig.options.physics) {
      for (let i = 0; i < 3; i++) {
        this.x[i].reset(delta[0]);
        this.y[i].reset(delta[1]);
      }
      return;
    }
    for (let i = 0; i < 3; i++) {
      const wind = rig.options.physics
        ? gust * (i + 1) * (this.front ? 2.2 : 5) * rig.options.motion
        : 0;
      const hangingLength = this.definition.end - root[1],
        angularDrag = clamp(
          ((rig.head.velocity || 0) *
            hangingLength *
            (this.front ? 0.13 : 0.18) *
            (i + 1)) /
            3,
          -16,
          16,
        );
      this.x[i].target =
        delta[0] * 0.45 +
        (i ? this.x[i - 1].value : delta[0]) * 0.55 +
        wind -
        angularDrag;
      this.y[i].target =
        delta[1] * 0.45 + (i ? this.y[i - 1].value : delta[1]) * 0.55;
      this.x[i].step(dt);
      this.y[i].step(dt);
    }
  }
  point(rig, x, y) {
    const { root, end } = this.definition,
      w = smoothstep(root[1], end, y),
      pRoot = rig.headTransform(...root);
    const delta = [pRoot[0] - root[0], pRoot[1] - root[1]],
      section = clamp(w * 2, 0, 2),
      index = Math.min(1, Math.floor(section));
    const delayed = [
      mix(this.x[index].value, this.x[index + 1].value, section - index),
      mix(this.y[index].value, this.y[index + 1].value, section - index),
    ];
    const p = rotate(x, y, ...root, rig.head.value * (1 - w) ** 2);
    return [
      p[0] + mix(delta[0], clamp(delayed[0], -35, 35), w),
      p[1] +
        mix(delta[1], delayed[1], w) +
        Math.abs(delayed[0] - delta[0]) * w * 0.035,
    ];
  }
  springs() {
    return [...this.x, ...this.y];
  }
}
