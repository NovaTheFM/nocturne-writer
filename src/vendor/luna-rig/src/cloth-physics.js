import { clamp } from "./math.js";
import { sleeveFreedom } from "./sleeve-drape.js";

/** One material panel for the bell and its rolled hem. Both draw calls use
 * exactly the same constrained particles; the lip cannot peel off the bag.
 * Structural, diagonal and signed-area constraints keep the painted volume.
 */
export class ClothPanel {
  snapshot() {
    return {
      position: this.position.slice(),
      previous: this.previous.slice(),
      lastPose: this.lastPose,
      lastTime: this.lastTime,
      target: this.target.slice(),
      targetDelta: this.targetDelta.slice(),
      previousDt: this.previousDt,
    };
  }
  restore(state) {
    this.position.set(state.position);
    this.previous.set(state.previous);
    this.lastPose = state.lastPose;
    this.lastTime = state.lastTime;
    this.target.set(state.target);
    this.targetDelta.set(state.targetDelta);
    this.previousDt = state.previousDt || 0;
  }
  constructor(sprite, lip, lining) {
    this.rest = new Float64Array(sprite.rest);
    this.position = new Float64Array(this.rest);
    this.previous = new Float64Array(this.rest);
    this.target = new Float64Array(this.rest);
    this.targetDelta = new Float64Array(this.rest.length);
    this.columns = sprite.columns;
    this.rows = sprite.rows;
    this.edges = [];
    this.triangles = [];
    const stride = this.columns + 1;
    this.active = Array.from({ length: this.rest.length / 2 }, (_, i) => {
      // Cloth paintings move through the shared canvas. Binding only the first
      // two poses made the raised bag's particles permanently kinematic.
      for (const field of sprite.poseKeyFrames || []) {
        const width = field.distance.width,
          height = field.distance.height,
          x = Math.min(
            width - 1,
            Math.round(((i % stride) / this.columns) * (width - 1)),
          ),
          y = Math.min(
            height - 1,
            Math.round((Math.floor(i / stride) / this.rows) * (height - 1)),
          ),
          k = (y * width + x) * 4,
          distance =
            (field.distancePixels[k] * 256 +
              field.distancePixels[k + 1] -
              32768) /
            32;
        if (distance > -32) return true;
      }
      if (!sprite.poseKeyFrames && sprite.distancePixelsB) {
        const x = Math.min(
            sprite.distanceWidth - 1,
            Math.round(
              ((i % stride) / this.columns) * (sprite.distanceWidth - 1),
            ),
          ),
          y = Math.min(
            sprite.distanceHeight - 1,
            Math.round(
              (Math.floor(i / stride) / this.rows) *
                (sprite.distanceHeight - 1),
            ),
          ),
          k = (y * sprite.distanceWidth + x) * 4,
          distance =
            (sprite.distancePixelsB[k] * 256 +
              sprite.distancePixelsB[k + 1] -
              32768) /
            32;
        if (distance > -32) return true;
      }
      const x = Math.round(
          ((i % stride) / this.columns) * (sprite.imageWidth - 1),
        ),
        y = Math.round(
          (Math.floor(i / stride) / this.rows) * (sprite.imageHeight - 1),
        );
      for (let oy = -3; oy <= 3; oy++)
        for (let ox = -3; ox <= 3; ox++) {
          const k =
            (clamp(y + oy, 0, sprite.imageHeight - 1) * sprite.imageWidth +
              clamp(x + ox, 0, sprite.imageWidth - 1)) *
              4 +
            3;
          if (
            sprite.alpha[k] > 20 ||
            lip.alpha[k] > 20 ||
            lining?.alpha[k] > 20
          )
            return true;
        }
      return false;
    });
    for (let y = 0; y <= this.rows; y++)
      for (let x = 0; x <= this.columns; x++) {
        const i = y * stride + x;
        for (const [dx, dy, stiffness] of [
          [1, 0, 0.9],
          [0, 1, 0.9],
          [1, 1, 0.55],
          [-1, 1, 0.55],
          [2, 0, 0.12],
          [0, 2, 0.12],
        ]) {
          if (x + dx < 0 || x + dx > this.columns || y + dy > this.rows)
            continue;
          const j = (y + dy) * stride + x + dx;
          if (this.active[i] && this.active[j])
            this.edges.push([
              i,
              j,
              Math.hypot(
                this.rest[i * 2] - this.rest[j * 2],
                this.rest[i * 2 + 1] - this.rest[j * 2 + 1],
              ),
              stiffness,
            ]);
        }
        if (x < this.columns && y < this.rows) {
          for (const t of [
            [i, i + 1, i + stride],
            [i + 1, i + stride + 1, i + stride],
          ])
            if (t.every((k) => this.active[k])) {
              const area = this.area(this.rest, ...t);
              this.triangles.push([...t, area]);
            }
        }
      }
    this.lastPose = 0;
    this.lastTime = 0;
    this.previousDt = 0;
    this.targetLengths = new Float64Array(this.edges.length);
    this.targetAreas = new Float64Array(this.triangles.length);
    this.mobility = new Float64Array(this.rest.length / 2);
  }
  area(p, a, b, c) {
    return (
      ((p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) -
        (p[b * 2 + 1] - p[a * 2 + 1]) * (p[c * 2] - p[a * 2])) *
      0.5
    );
  }
  solve(context, targetPoint) {
    const pose = context.pose,
      time = context.time;
    if (pose === 0 && Math.abs(context.sleeveLag?.value || 0) < 1e-8) {
      this.position.set(this.rest);
      this.previous.set(this.rest);
      this.target.set(this.rest);
      this.targetDelta.fill(0);
      this.lastPose = pose;
      this.lastTime = time;
      this.previousDt = 0;
      return;
    }
    const p = this.position,
      previous = this.previous,
      rest = this.rest,
      n = p.length / 2,
      source = context.armModel.forearm.rest,
      c = Math.cos(source.angle),
      s = Math.sin(source.angle),
      elapsed = time - this.lastTime,
      jump =
        Math.abs(pose - this.lastPose) > 0.12 ||
        elapsed < 0 ||
        elapsed > 0.15 ||
        (!elapsed && pose !== this.lastPose),
      dt = clamp(elapsed, 0, 1 / 20),
      timeRatio = this.previousDt > 0 ? dt / this.previousDt : 1,
      damping = Math.exp(-8 * dt),
      targets = new Float64Array(p.length),
      mass = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const x = rest[i * 2],
        y = rest[i * 2 + 1],
        target = targetPoint(x, y),
        chartX = context.manifest.mirror ? context.manifest.mirror - x : x,
        dx = chartX - source.origin[0],
        dy = y - source.origin[1],
        along = dx * c + dy * s,
        across = -dx * s + dy * c;
      targets[i * 2] = target[0];
      targets[i * 2 + 1] = target[1];
      const seam = y < 523,
        cuff = along > 68 && Math.abs(across) < 24 && y > 574,
        attachedFreedom = sleeveFreedom(context, chartX, y);
      mass[i] = this.active[i]
        ? (attachedFreedom ?? (!seam && !cuff ? 1 : 0))
        : 0;
      for (let k = 0; k < 2; k++) {
        const j = i * 2 + k,
          transport = targets[j] - this.target[j];
        // Transport the previous simulation to the new pose before solving
        // residual fabric motion. Fixed pins and free particles now share the
        // same moving chart instead of tearing the sleeve during an arm lift.
        p[j] += transport;
        previous[j] += transport;
        const old = p[j],
          inertia =
            jump || !dt
              ? 0
              : (this.targetDelta[j] * timeRatio - transport) * 0.38;
        if (jump || !mass[i] || context.options?.physics === false)
          p[j] = targets[j];
        else if (!dt) p[j] = old;
        else
          p[j] +=
            (p[j] - previous[j]) * damping * timeRatio +
            (targets[j] - p[j]) * Math.min(0.16, 38 * dt * dt) +
            inertia * mass[i];
        if (dt || jump || context.options?.physics === false) previous[j] = old;
        this.target[j] = targets[j];
        if (dt || jump) this.targetDelta[j] = jump ? 0 : transport;
      }
    }
    this.mobility.set(mass);
    if (context.options?.physics === false) {
      p.set(targets);
      previous.set(targets);
      this.lastTime = time;
      this.lastPose = pose;
      this.previousDt = 0;
      return;
    }
    if (!dt && !jump) return;
    for (let i = 0; i < this.edges.length; i++) {
      const [a, b] = this.edges[i];
      this.targetLengths[i] = Math.hypot(
        targets[b * 2] - targets[a * 2],
        targets[b * 2 + 1] - targets[a * 2 + 1],
      );
    }
    for (let i = 0; i < this.triangles.length; i++) {
      const [a, b, c] = this.triangles[i];
      this.targetAreas[i] = this.area(targets, a, b, c);
    }
    const iterations = jump ? 95 : 14;
    for (let pass = 0; pass < iterations; pass++) {
      let edgeIndex = 0;
      for (const [a, b, _length, stiffness] of this.edges) {
        // These are projected painted surfaces: forearm foreshortening is a
        // valid pose change, not 2D fabric strain to push back into the image.
        const length = this.targetLengths[edgeIndex++];
        const dx = p[b * 2] - p[a * 2],
          dy = p[b * 2 + 1] - p[a * 2 + 1],
          distance = Math.hypot(dx, dy),
          sum = mass[a] + mass[b];
        if (!sum || distance < 1e-7) continue;
        const correction = (((distance - length) / distance) * stiffness) / sum;
        p[a * 2] += dx * correction * mass[a];
        p[a * 2 + 1] += dy * correction * mass[a];
        p[b * 2] -= dx * correction * mass[b];
        p[b * 2 + 1] -= dy * correction * mass[b];
      }
      let triangleIndex = 0;
      for (const [a, b, c, _originalArea] of this.triangles) {
        const area = this.area(p, a, b, c),
          minimum = this.targetAreas[triangleIndex++] * 0.3;
        if (area >= minimum) continue;
        const gradients = [
          [p[b * 2 + 1] - p[c * 2 + 1], p[c * 2] - p[b * 2]],
          [p[c * 2 + 1] - p[a * 2 + 1], p[a * 2] - p[c * 2]],
          [p[a * 2 + 1] - p[b * 2 + 1], p[b * 2] - p[a * 2]],
        ];
        const indices = [a, b, c];
        let denominator = 0;
        for (let k = 0; k < 3; k++)
          denominator +=
            mass[indices[k]] *
            (gradients[k][0] ** 2 + gradients[k][1] ** 2) *
            0.25;
        if (denominator < 1e-10) continue;
        const lambda = ((minimum - area) / denominator) * 0.8;
        for (let k = 0; k < 3; k++) {
          const index = indices[k];
          p[index * 2] += gradients[k][0] * 0.5 * lambda * mass[index];
          p[index * 2 + 1] += gradients[k][1] * 0.5 * lambda * mass[index];
        }
      }
      for (let i = 0; i < n; i++)
        if (!mass[i]) {
          p[i * 2] = targets[i * 2];
          p[i * 2 + 1] = targets[i * 2 + 1];
        }
    }
    // Feasible line search on residual motion after constraint projection.
    // Keep every visible triangle above its posed minimum signed area.
    for (let pass = 0; pass < 9; pass++) {
      if (
        this.triangles.every(
          ([a, b, c], i) => this.area(p, a, b, c) >= this.targetAreas[i] * 0.2,
        )
      )
        break;
      for (let j = 0; j < p.length; j++) {
        p[j] = targets[j] + (p[j] - targets[j]) * 0.5;
        previous[j] = targets[j] + (previous[j] - targets[j]) * 0.5;
      }
    }
    if (jump) this.previous.set(p);
    this.previousDt = dt;
    this.lastTime = time;
    this.lastPose = pose;
  }
}
