import { RigController, EMOTIONS, ZONE_LABELS } from "./rig-controller.js";
import {
  clamp,
  mix,
  rotate,
  smoothstep,
  armFrame,
  framePoint,
} from "./math.js";
import {
  blinkClosure,
  eyeShape,
  mouthShape,
  surfacePoint,
  strokePoint,
  apertureMask,
  boundsAt,
  faceWorld,
  browPoint,
  nativeInkPoint,
  nativeSceneInkPoint,
} from "./face-rig.js";
import {
  forearmFrame,
  palmPoint,
  fingerPoint,
  handFacing,
  upperSleevePoint,
  upperArmPoint,
} from "./hand-rig.js";
import { coatPoint } from "./cloth-rig.js";
import { armContext } from "./arm-context.js";
import { bindNativeAssembly, renderNativeAssembly } from "./native-assembly.js";
import { rgbaPng } from "./png-rgba.js";
import {
  clothChartParameters,
  clothChartForward,
  clothChartInverse,
} from "./cloth-chart.js";
import { cuffChartParameters, cuffForward, cuffInverse } from "./cuff-chart.js";
import { garmentFrame } from "./garment-chart.js";
export { EMOTIONS, ZONE_LABELS };

async function imageAt(url, raw = false) {
  if (raw) {
    return rgbaPng(url);
  }
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

/** A layered puppet: the reference image is not loaded by the runtime. */
export class LunaRig extends RigController {
  constructor(canvas, options = {}) {
    super(canvas, options);
    this.fullFrame = Boolean(options.fullFrame);
  }
  async load() {
    const response = await fetch(new URL("manifest.json", this.assets));
    if (!response.ok) throw new Error(`manifest.json: ${response.status}`);
    this.manifest = await response.json();
    this.model = this.manifest.model;
    if (
      this.manifest.version !== 4 ||
      !this.manifest.faceRig ||
      !this.manifest.handRig
    )
      throw new Error("This rig requires articulated face and hand materials.");
    const poseImages = new Map();
    const loadPoseImage = (url, raw) => {
      const key = String(url) + String(raw);
      if (!poseImages.has(key)) poseImages.set(key, imageAt(url, raw));
      return poseImages.get(key);
    };
    const entries = await Promise.all(
      Object.entries(this.manifest.parts).map(async ([name, part]) => {
        const image = await loadPoseImage(
          new URL(part.file, this.assets),
          part.rawPremultiplied,
        );
        const sprite = this.renderer.makeSprite(image, part.rect, {
          name,
          zone: part.zone,
          columns: part.columns,
          rows: part.rows,
          raw: Boolean(part.second || part.rawPremultiplied),
          mipmaps: part.mipmaps !== false,
          nativeCoverage: Boolean(part.nativeCoverage),
          nativePixels: Boolean(part.rawPremultiplied),
          premultipliedMorph: Boolean(part.premultipliedMorph),
          morphColour: part.morphColour,
          morphKind: part.morphKind,
          inkRoot: part.inkRoot,
        });
        if (part.poseKeys) {
          sprite.materialChart = part.materialChart;
          sprite.materialCategory = part.materialCategory;
          sprite.sharedGarment = Boolean(part.sharedGarment);
          const frames = await Promise.all(
            part.poseKeys.map(async (key) => {
              const read = async (field, raw = true) =>
                key[field]
                  ? loadPoseImage(new URL(key[field], this.assets), raw)
                  : null;
              const [colour, distance, paint, flow, mask] = await Promise.all([
                read("file"),
                read("distance", false),
                read("paint"),
                read("flow"),
                read("mask"),
              ]);
              return { ...key, image: colour, distance, paint, flow, mask };
            }),
          );
          this.renderer.attachPoseKeys(
            sprite,
            frames,
            Boolean(part.maskInvert),
          );
          return [name, sprite];
        }
        if (part.side)
          this.renderer.attachSide(
            sprite,
            await imageAt(
              new URL(part.side, this.assets),
              part.rawPremultiplied,
            ),
            Boolean(part.rawPremultiplied),
          );
        if (part.mask)
          this.renderer.attachMask(
            sprite,
            await imageAt(new URL(part.mask, this.assets), true),
            Boolean(part.maskInvert),
          );
        sprite.layerMaskMorph = Boolean(part.maskMorph);
        if (part.round) {
          const [colour, distance] = await Promise.all([
            imageAt(new URL(part.round, this.assets), true),
            imageAt(
              new URL(part.distanceRound, this.assets),
              Boolean(part.materialFlowScale || part.nativeHandVisibility),
            ),
          ]);
          this.renderer.attachRound(
            sprite,
            colour,
            distance,
            Boolean(part.materialFlowScale || part.nativeHandVisibility),
          );
          sprite.materialFlowScale = part.materialFlowScale || 0;
          sprite.nativeHandVisibility = Boolean(part.nativeHandVisibility);
        }
        if (part.second) {
          const [second, a, b] = await Promise.all(
            [part.second, part.distanceA, part.distanceB].map((p, index) =>
              imageAt(
                new URL(p, this.assets),
                index === 0 && part.rawPremultiplied,
              ),
            ),
          );
          this.renderer.attachMorph(sprite, second, a, b);
        }
        return [name, sprite];
      }),
    );
    this.sprites = Object.fromEntries(entries);
    this.armModel = this.manifest.arm;
    this.setWaveSide(this.manifest.preferredWaveSide || "left");
    if (this.manifest.referenceAssembly) bindNativeAssembly(this);
    this.ready = true;
    this.resize();
    this.update(0);
    this.render();
    if (this.autoStart) this.start();
    this.emit("ready");
  }
  resize() {
    super.resize();
    const inspected = {
      hair: [300, 35, 940, 730],
      clothes: [325, 275, 930, 825],
      face: [490, 125, 718, 325],
      arm:
        this.waveSide === "right" && this.manifest?.arms?.right
          ? [525, 230, 960, 740]
          : [285, 230, 715, 740],
      legs: [476, 627, 753, 1235],
      hat: [488, 0, 865, 270],
    }[this.inspection];
    const camera = this.fullFrame
      ? { left: 0, top: 0, right: this.model.width, bottom: this.model.height }
      : inspected
        ? {
            left: inspected[0],
            top: inspected[1],
            right: inspected[2],
            bottom: inspected[3],
          }
        : this.manifest?.camera;
    if (!camera) return;
    this.scale =
      Math.min(
        this.width / (camera.right - camera.left),
        this.height / (camera.bottom - camera.top),
      ) *
      0.94 *
      this.options.zoom;
    this.offset = [
      this.width / 2 - (camera.left + camera.right) * 0.5 * this.scale,
      this.height / 2 - (camera.top + camera.bottom) * 0.5 * this.scale,
    ];
    if (this.ready) this.render();
  }
  headTransform(x, y) {
    const p = rotate(x, y, 619, 310, this.head.value);
    return [p[0], p[1] + this.breath - this.recoil.value * 0.15];
  }
  bodyTransform(x, y) {
    const weight = (1 - smoothstep(566, 720, y)) * smoothstep(275, 355, y);
    return [
      619 + (x - 619) * (1 + this.breath * 0.0008 * weight),
      y + this.breath * weight - this.recoil.value * 0.1 * weight,
    ];
  }
  hatTransform(x, y) {
    const p = this.hatPhysics.point(x, y);
    return this.headTransform(
      ...rotate(...p, 617, 123, this.hat.value * smoothstep(625, 800, x)),
    );
  }
  hatLocal(x, y) {
    const p = rotate(
      x,
      y - this.breath + this.recoil.value * 0.15,
      619,
      310,
      -this.head.value,
    );
    return rotate(...p, 617, 123, -this.hat.value);
  }
  pompomTransform(x, y) {
    const centre = this.hatPhysics.pompom(),
      p = rotate(x, y, 820, 220, this.hatPhysics.pompomAngle());
    return this.headTransform(
      ...rotate(
        p[0] + centre[0] - 820,
        p[1] + centre[1] - 220,
        617,
        123,
        this.hat.value,
      ),
    );
  }
  hairTransform(x, y, side, front = false) {
    return this.hairChains[(front ? "front-" : "back-") + side].point(
      this,
      x,
      y,
    );
  }
  crownTransform(x, y) {
    const skull = this.headTransform(x, y),
      strand = this.hairTransform(x, y, x < 619 ? "left" : "right", true),
      softness = smoothstep(260, 334, y) * 0.8;
    return [
      mix(skull[0], strand[0], softness),
      mix(skull[1], strand[1], softness),
    ];
  }
  legTransform(x, y, side) {
    const cx = side === "left" ? 555 : 678;
    const angle = this.legAngles[side].value;
    const weight = smoothstep(655, 815, y);
    return rotate(x, y, cx, 685, angle * weight);
  }
  armTransform(u, v, material = "coat", side = this.waveSide) {
    const context = armContext(this, side) || armContext(this, "left");
    if (context.manifest.poseArt && ["coat", "cuff"].includes(material)) {
      const part =
          this.manifest.parts[
            context.prefix + (material === "cuff" ? "-cuff-back" : "-coat-back")
          ],
        chart = part.materialChart,
        [x, y, w, h] = part.rect,
        source = [x + u * w, y + v * h],
        mirror = context.manifest.mirror;
      if (mirror) source[0] = mirror - source[0];
      const shared = chart.kind === "garment", affine = chart.kind === "cuff" || material === "cuff",
        parameters = shared ? garmentFrame : affine ? cuffChartParameters : clothChartParameters,
        inverse = shared || affine ? cuffInverse : clothChartInverse,
        forward = shared || affine ? cuffForward : clothChartForward,
        point = forward(
          inverse(source, parameters(chart, 0)),
          parameters(chart, context.pose),
        );
      return this.bodyTransform(
        ...(mirror ? [mirror - point[0], point[1]] : point),
      );
    }
    const point =
      material === "hand"
        ? palmPoint(context, u, v)
        : material === "coat"
          ? coatPoint(context, u, v)
          : framePoint(forearmFrame(context), u, v);
    return this.bodyTransform(
      ...(context.toWorld ? context.toWorld(point) : point),
    );
  }
  pompomAnchor() {
    return this.pompomTransform(820, 220);
  }
  setInspection(group = null) {
    if (
      group &&
      !["hair", "clothes", "face", "arm", "legs", "hat"].includes(group) &&
      !this.sprites[group]
    )
      throw new RangeError(`Unknown rig part: ${group}`);
    this.inspection = group || null;
    this.resize();
  }
  matchesInspection(name) {
    const group = this.inspection;
    if (!group) return true;
    if (group === "clothes")
      return /^(dress|costume|bow|brooch|shoulder-frill)|^arm(?:-right)?-(upper|coat|lining|elbow-frill)/.test(
        name,
      );
    if (group === "face")
      return /^(face|neck|ear|eye|lid|mouth|hair-crown|hair-front|hat|pompom)/.test(
        name,
      );
    if (group === "legs") return /^(leg|boot|knee)/.test(name);
    if (group === "hat") return /^(hat|pom)/.test(name);
    if (group === "arm")
      return this.waveSide === "right"
        ? name.startsWith("arm-right") || name === "shoulder-frill-right"
        : (name.startsWith("arm") && !name.startsWith("arm-right")) ||
            name === "shoulder-frill-left";
    return ["hair"].includes(group) ? name.startsWith(group) : name === group;
  }
  snapshot(pose = 0) {
    const inspection = this.inspection;
    const cloth = Object.fromEntries(
      Object.entries(this.nativeCloth || {}).map(([side, panel]) => [
        side,
        panel.snapshot(),
      ]),
    );
    this.inspection = null;
    this.resize();
    try {
      return super.snapshot(pose);
    } finally {
      for (const [side, state] of Object.entries(cloth))
        this.nativeCloth[side].restore(state);
      this.inspection = inspection;
      this.resize();
    }
  }
  eyeClosure() {
    const blink =
      this.blinkTime >= 0 ? blinkClosure(this.time - this.blinkTime) : 0;
    const weights = this.getEmotionWeights();
    const expression =
      smoothstep(0, 0.7, weights.happy + weights.sleepy) +
      weights.annoyed * 0.22;
    return 1 - (1 - blink) * (1 - clamp(expression, 0, 1));
  }
  render() {
    if (!this.ready || this.destroyed) return;
    if (this.manifest.referenceAssembly) return renderNativeAssembly(this);
    this.renderer.begin(this.width, this.height);
    this.drawOrder = [];
    const draw = (name, fn, opacity = 1) => {
      const s = this.sprites[name];
      if (!s || !this.matchesInspection(name)) return;
      s.opacity = opacity;
      if (opacity < 0.001) return;
      this.drawOrder.push(s);
      this.renderer.draw(s, (x, y, u, v) => {
        const p = fn(x, y, u, v);
        return [
          p[0] * this.scale + this.offset[0],
          p[1] * this.scale + this.offset[1],
        ];
      });
    };
    const body = (x, y) => this.bodyTransform(x, y),
      head = (x, y) => this.headTransform(x, y);
    const facial = (x, y) => head(...faceWorld(this, x, y));
    const arms = ["left", "right"]
        .map((side) => armContext(this, side))
        .filter(Boolean),
      prefix = (context) => context.prefix || "arm",
      armWorld = (context, point) =>
        body(...(context.toWorld ? context.toWorld(point) : point));
    for (const context of arms)
      draw(prefix(context) + "-upper", (x, y, u, v) =>
        armWorld(context, upperSleevePoint(context, u, v)),
      );
    for (const side of ["left", "right"])
      draw(`hair-back-${side}`, (x, y) => this.hairTransform(x, y, side));
    draw("hair-crown-back", (x, y) => this.crownTransform(x, y));
    draw("neck", (x, y) => {
      const a = head(x, y),
        b = body(x, y),
        weight = smoothstep(300, 346, y);
      return [a[0] + (b[0] - a[0]) * weight, a[1] + (b[1] - a[1]) * weight];
    });
    draw("costume-complete", body);
    draw("dress-back", body);
    for (const side of ["left", "right"]) draw(`shoulder-frill-${side}`, body);
    for (const name of [
      "bow-loop-left",
      "bow-loop-right",
      "bow-tail-left",
      "bow-tail-right",
    ])
      draw(name, (x, y) => {
        const side = name.endsWith("left") ? -1 : 1,
          tail = name.includes("tail"),
          angle =
            this.ribbon.value *
            side *
            (tail ? 1 : 0.35) *
            smoothstep(385, 480, y);
        return body(...rotate(x, y, 616, 382, angle));
      });
    draw("brooch", body);
    for (const context of arms) {
      if (this.sprites[prefix(context) + "-coat-back"])
        this.sprites[prefix(context) + "-coat-back"].mix = smoothstep(
          0,
          1,
          context.pose,
        );
      draw(prefix(context) + "-coat-back", (x, y, u, v) =>
        armWorld(context, coatPoint(context, u, v)),
      );
    }
    for (const side of ["left", "right"]) {
      const leg = (x, y) => this.legTransform(x, y, side);
      draw(`leg-${side}`, leg);
      draw(`boot-${side}`, leg);
    }
    draw("arm-coat", (x, y, u, v) => this.armTransform(u, v, "coat", "left"));
    draw("dress-front", body);
    draw("face", head);
    const expression = this.getEmotionWeights(),
      blush =
        expression.shy * 0.65 +
        expression.happy * 0.12 +
        expression.annoyed * 0.15;
    for (const side of ["left", "right"])
      draw("face-blush-" + side, head, blush);

    const closure = this.eyeClosure();
    for (const side of ["left", "right"]) {
      const shape = eyeShape(this, side, closure),
        mask = apertureMask(this, shape);
      this.sprites[`eye-white-${side}`].aperture = mask;
      draw(`eye-white-${side}`, (x, y, u, v) =>
        facial(...surfacePoint(shape, u, v)),
      );
      const iris = this.sprites[`eye-iris-${side}`];
      iris.aperture = mask;
      if (shape.irisSceneRect) {
        const rect = shape.irisSceneRect,
          base = this.manifest.faceRig.eyes[side],
          angle = this.manifest.faceRig.head.angle,
          c = Math.cos(angle),
          s = Math.sin(angle),
          gx = shape.irisX - base.iris[0],
          gy = shape.irisY - base.iris[1];
        draw(`eye-iris-${side}`, (x, y, u, v) =>
          head(
            rect[0] + u * rect[2] + gx * c - gy * s,
            rect[1] + v * rect[3] + gx * s + gy * c,
          ),
        );
      } else {
        draw(`eye-iris-${side}`, (x, y, u, v) =>
          facial(
            shape.irisX + u * shape.iris[2],
            shape.irisY + v * shape.iris[3],
          ),
        );
      }
      this.sprites[`eye-upper-${side}`].mix = smoothstep(0.25, 0.9, closure);
      draw(`eye-upper-${side}`, (x, y, u, v) =>
        facial(
          ...(shape.lashSceneRect
            ? nativeSceneInkPoint(
                this,
                shape,
                this.manifest.faceRig.eyes[side],
                shape.lashSceneRect,
                u,
                v,
              )
            : shape.lashRect
              ? nativeInkPoint(
                  shape,
                  this.manifest.faceRig.eyes[side],
                  shape.lashRect,
                  u,
                  v,
                )
              : strokePoint(shape, u, v, {
                  height: shape.lashHeight,
                  extension: 0.045,
                })),
        ),
      );
      draw(
        `eye-lower-${side}`,
        (x, y, u, v) =>
          facial(...strokePoint(shape, u, v, { height: 4, lower: true })),
        1 - smoothstep(0.1, 0.65, closure),
      );
      if (
        this.manifest.faceRig.kind === "reference" &&
        !this.manifest.faceRig.nativeBrowsInCrown
      )
        draw("eye-brow-" + side, (x, y) =>
          head(...browPoint(this, side, x, y)),
        );
    }
    const shape = mouthShape(this),
      base = this.manifest.faceRig.mouth,
      mask = apertureMask(this, shape);
    this.sprites["mouth-cavity"].aperture = mask;
    draw("mouth-cavity", (x, y, u, v) => facial(...surfacePoint(shape, u, v)));
    if (this.sprites["mouth-teeth"]) {
      this.sprites["mouth-teeth"].aperture = mask;
      draw(
        "mouth-teeth",
        (x, y, u, v) => {
          const upper = base.y + base.slope * u + base.top * 4 * u * (1 - u);
          return facial(base.x + u * base.width, upper + 0.5 + v * 0.95);
        },
        1 - smoothstep(0.25, 0.85, shape.round),
      );
    }
    this.sprites["mouth-tongue"].aperture = mask;
    if (base.tongue) {
      const shift = boundsAt(shape, 0.5)[1] - boundsAt(base, 0.5)[1];
      draw("mouth-tongue", (x, y) => facial(x, y + shift));
    } else {
      const tongueY = boundsAt(shape, 0.5)[1] - 5.5;
      draw("mouth-tongue", (x, y, u, v) =>
        facial(base.x + 4 + u * (base.width - 8), tongueY + v * 7),
      );
    }
    draw("mouth-upper", (x, y, u, v) =>
      facial(
        ...(base.inkSceneRects
          ? nativeSceneInkPoint(
              this,
              shape,
              base,
              base.inkSceneRects.upper,
              u,
              v,
            )
          : base.inkRects
            ? nativeInkPoint(shape, base, base.inkRects.upper, u, v)
            : strokePoint(shape, u, v, { height: base.lipHeight })),
      ),
    );
    draw(
      "mouth-lower",
      (x, y, u, v) =>
        facial(
          ...(base.inkSceneRects
            ? nativeSceneInkPoint(
                this,
                shape,
                base,
                base.inkSceneRects.lower,
                u,
                v,
                "lower",
              )
            : base.inkRects
              ? nativeInkPoint(shape, base, base.inkRects.lower, u, v, "lower")
              : strokePoint(shape, u, v, {
                  height: base.lipHeight,
                  lower: true,
                })),
        ),
      smoothstep(0.025, 0.14, shape.opening),
    );
    for (const side of ["left", "right"])
      draw(`hair-front-${side}`, (x, y) =>
        this.hairTransform(x, y, side, true),
      );
    for (const context of arms)
      draw(prefix(context) + "-elbow-frill", (x, y) =>
        armWorld(context, upperArmPoint(context, x, y)),
      );
    draw("hat", (x, y) => this.hatTransform(x, y));
    draw("hair-crown", (x, y) => this.crownTransform(x, y));
    for (const context of arms) {
      const name = prefix(context),
        length = forearmFrame(context).length;
      this.sprites[name + "-forearm"].clipFrom = clamp(94 / length, 0, 1);
      draw(
        name + "-forearm",
        (x, y, u, v) =>
          armWorld(context, framePoint(forearmFrame(context), u, v)),
        smoothstep(0, 0.025, context.pose),
      );
      this.sprites[name + "-coat-front"].mix = smoothstep(0, 1, context.pose);
      draw(name + "-coat-front", (x, y, u, v) =>
        armWorld(context, coatPoint(context, u, v)),
      );
      for (const digit of ["little", "ring", "middle", "index", "thumb"]) {
        const sprite = this.sprites[name + "-finger-" + digit];
        sprite.mix = handFacing(context);
        draw(sprite.name, (x, y, u, v) =>
          armWorld(context, fingerPoint(context, digit, u, v)),
        );
      }
      this.sprites[name + "-palm"].mix = handFacing(context);
      draw(name + "-palm", (x, y, u, v) =>
        armWorld(context, palmPoint(context, u, v)),
      );
    }
    draw("hand-right", body);
    draw("pompom", (x, y) => this.pompomTransform(x, y));
    this.pompomPosition = this.pompomAnchor();
    this.emit("frame", {
      time: this.time,
      pose: this.pose,
      emotion: this.emotion,
      drawCalls: this.renderer.drawCalls,
      head: this.head.value,
      hair: this.hairLeft[2].value,
      pompom: this.pompomPosition,
    });
  }
  hitTest(x, y) {
    this.hitPart = null;
    for (let i = this.drawOrder.length - 1; i >= 0; i--) {
      const s = this.drawOrder[i];
      if (this.renderer.hitUV(s, x, y)) {
        this.hitPart = s.name;
        return s.zone;
      }
    }
    return null;
  }
}
