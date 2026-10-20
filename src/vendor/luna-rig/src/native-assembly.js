import { clamp, mix, smoothstep, rotate, framePoint } from "./math.js";
import { armContext } from "./arm-context.js";
import {
  fingerPoint,
  palmPoint,
  upperArmPoint,
  forearmFrame,
  handTurn,
  handFrame,
  upperArmAngle,
} from "./hand-rig.js";
import { pointWarp } from "./point-warp.js";
import { ClothPanel } from "./cloth-physics.js";
import { handSurfaceTargets, skinHandPoint } from "./hand-surface.js";
import {
  drapePoint,
  cuffContour,
  clothTurn,
  sleeveFrillPoint,
} from "./sleeve-drape.js";
import { samplePoseArt, poseHandPoint } from "./pose-art.js";
import { cuffChartParameters, cuffInverse } from "./cuff-chart.js";
import {
  eyeShape,
  apertureMask,
  faceWorld,
  mouthShape,
  boundsAt,
} from "./face-rig.js";

function at(values, u) {
  const t = clamp(u, 0, 1) * (values.length - 1),
    i = Math.min(values.length - 2, Math.floor(t));
  return mix(values[i], values[i + 1], t - i);
}
function headLocal(rig, x, y) {
  const head = rig.manifest.faceRig.head,
    c = Math.cos(head.angle),
    s = Math.sin(head.angle);
  x -= head.origin[0];
  y -= head.origin[1];
  return [x * c + y * s, -x * s + y * c];
}
function restContext(context) {
  if (context.nativeRest) return context.nativeRest;
  const rest = Object.create(context);
  rest.pose = 0;
  rest.waveGesture = { value: 0 };
  rest.sleeveLag = { value: 0 };
  rest.cachedForearmFrame = null;
  rest.cachedHandFrame = null;
  rest.cachedPoseArt = null;
  return rest;
}

function cacheArm(context) {
  if (context.manifest.poseArt) context.cachedPoseArt = samplePoseArt(context);
  const rest = restContext(context);
  if (context.manifest.poseArt) rest.cachedPoseArt = samplePoseArt(rest);
  rest.cachedForearmFrame = forearmFrame(rest);
  rest.cachedHandFrame = handFrame(rest);
  context.cachedForearmFrame = forearmFrame(context);
  context.cachedHandFrame = handFrame(context);
  for (const frame of [rest.cachedHandFrame, context.cachedHandFrame]) {
    frame.cosine = Math.cos(frame.angle);
    frame.sine = Math.sin(frame.angle);
  }
  context.nativeRest = rest;
  return context;
}

/** Bind once in source coordinates; the rest pose is the identity mapping. */
export function bindNativeAssembly(rig) {
  rig.nativePalms = {};
  rig.nativeHands = {};
  rig.nativeCloth = {};
  for (const side of ["left", "right"]) {
    const context = armContext(rig, side),
      prefix = context.prefix;
    rig.nativeCloth[side] = new ClothPanel(
      rig.sprites[prefix + "-coat-back"],
      rig.sprites[prefix + "-coat-front"] || rig.sprites[prefix + "-coat-back"],
      rig.sprites[prefix + "-lining"],
    );
    if (context.manifest.poseArt) continue;
    const whole = rig.sprites[prefix + "-hand"];
    if (whole) {
      const description = rig.manifest.parts[prefix + "-hand"];
      if (description.skinWeights) {
        rig.nativeHands[side] = {
          bones: description.skinBones,
          weights: description.skinWeights,
          fingers: description.fingerOrder,
        };
        continue;
      }
      const warp = pointWarp(description.anchors),
        weights = [];
      for (let k = 0; k < whole.rest.length; k += 2)
        weights.push(
          warp.weights(
            context.manifest.mirror
              ? context.manifest.mirror - whole.rest[k]
              : whole.rest[k],
            whole.rest[k + 1],
          ),
        );
      rig.nativeHands[side] = {
        warp,
        weights,
        fingers: description.fingerOrder,
      };
      continue;
    }
    const model = context.manifest.handRig.palm;
    if (model.binding === "affine") {
      rig.nativePalms[side] = { affine: true };
      continue;
    }
    const frame = context.armModel.hand.rest;
    const c = Math.cos(frame.angle),
      s = Math.sin(frame.angle);
    const fingers = ["little", "ring", "middle", "index", "thumb"];
    const anchors = [
      ...[-0.33, 0.33].map((u) => [
        frame.origin[0] - 9 * c - u * model.restWidth * s,
        frame.origin[1] - 9 * s + u * model.restWidth * c,
      ]),
      ...fingers.map(
        (name) => rig.manifest.referenceAssembly.digits[side][name].root,
      ),
    ];
    const warp = pointWarp(anchors),
      weights = {};
    for (const name of [prefix + "-palm", prefix + "-complete-palm"]) {
      const palm = rig.sprites[name];
      if (!palm) continue;
      weights[name] = [];
      for (let k = 0; k < palm.rest.length; k += 2) {
        const x = context.manifest.mirror
          ? context.manifest.mirror - palm.rest[k]
          : palm.rest[k];
        weights[name].push(warp.weights(x, palm.rest[k + 1]));
      }
    }
    rig.nativePalms[side] = { warp, weights, fingers };
  }
}

export function nativeCuffLength(context, frame = forearmFrame(context)) {
  if (context.manifest.poseArt) {
    const art = samplePoseArt(context);
    if (context.manifest.armPoseMaterials?.version >= 9) {
      if (context.pose < 1e-8) return frame.length;
      const prefix =
          context.prefix || (context.manifest.mirror ? "arm-right" : "arm"),
        chart = context.manifest.parts[prefix + "-cuff-front"].materialChart,
        cuff =
          context.sprites?.[prefix + "-cuff-front"]?.cuffCurrent ||
          cuffChartParameters(chart, context.pose),
        a = cuffInverse(frame.origin, cuff),
        b = cuffInverse(
          [
            frame.origin[0] + Math.cos(frame.angle),
            frame.origin[1] + Math.sin(frame.angle),
          ],
          cuff,
        ),
        d = b.map((v, i) => v - a[i]),
        quadratic = d[0] ** 2 + d[1] ** 2,
        linear = 2 * (a[0] * d[0] + a[1] * d[1]),
        constant = a[0] ** 2 + a[1] ** 2 - 1,
        discriminant = linear ** 2 - 4 * quadratic * constant;
      if (quadratic > 1e-12 && discriminant >= 0)
        return clamp(
          (-linear - Math.sqrt(discriminant)) / (2 * quadratic),
          0,
          frame.length,
        );
      throw new Error("Forearm axis misses the sleeve opening");
    }
    return clamp(
      (art.cuff[0] - art.elbow[0]) * Math.cos(frame.angle) +
        (art.cuff[1] - art.elbow[1]) * Math.sin(frame.angle) -
        30 * smoothstep(0, 0.2, context.pose),
      0,
      frame.length,
    );
  }
  const contour = cuffContour(context).map((p) =>
      nativeClothPoint(context, ...p),
    ),
    axis = [Math.cos(frame.angle), Math.sin(frame.angle)],
    cross = (u, v) => u[0] * v[1] - u[1] * v[0];
  let intersection = 0;
  for (let i = 1; i < contour.length; i++) {
    const a = contour[i - 1],
      b = contour[i],
      edge = [b[0] - a[0], b[1] - a[1]],
      offset = [a[0] - frame.origin[0], a[1] - frame.origin[1]],
      denominator = cross(axis, edge);
    if (Math.abs(denominator) < 1e-6) continue;
    const along = cross(offset, edge) / denominator,
      segment = cross(offset, axis) / denominator;
    if (segment >= 0 && segment <= 1 && along > 0 && along <= frame.length)
      intersection = Math.max(intersection, along);
  }
  // At rest the wrist continues under the lap cuff. The old .65 fallback
  // exposed a rectangular forearm before the cuff had even left the dress.
  if (!intersection)
    intersection =
      frame.length * (1 - 0.35 * smoothstep(0.16, 0.5, context.pose));
  return clamp(intersection, 8, Math.max(8, frame.length));
}

export function nativeClothPoint(context, x, y) {
  return drapePoint(context, x, y);
}

function handPoint(rig, context, side, name, x, y) {
  const mirror = context.manifest.mirror;
  if (mirror) x = mirror - x;
  const rest = restContext(context),
    frame = context.armModel.hand.rest;
  let u, v, current, baseline;
  if (name.endsWith("-palm")) {
    const c = Math.cos(frame.angle),
      s = Math.sin(frame.angle),
      dx = x - frame.origin[0],
      dy = y - frame.origin[1];
    const palm = context.manifest.handRig.palm;
    u = (-dx * s + dy * c) / palm.restWidth + 0.5;
    v = (dx * c + dy * s + 9) / (palm.restLength + 9);
    current = palmPoint(context, u, v);
    baseline = palmPoint(rest, u, v);
  } else {
    const digit = name.split("-finger-")[1],
      description = rig.manifest.referenceAssembly.digits[side][digit];
    const [a, b] = [description.root, description.tip],
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      length = Math.hypot(dx, dy);
    v = ((x - a[0]) * dx + (y - a[1]) * dy) / (length * length);
    u =
      (-(x - a[0]) * dy + (y - a[1]) * dx) / (length * description.width) + 0.5;
    current = fingerPoint(context, digit, u, v);
    baseline = fingerPoint(rest, digit, u, v);
  }
  const delta = rotate(
    x - baseline[0],
    y - baseline[1],
    0,
    0,
    handFrame(context).angle - handFrame(rest).angle,
  );
  const residual = 1 - smoothstep(0, 0.35, context.pose);
  const p = [
    current[0] + delta[0] * residual,
    current[1] + delta[1] * residual,
  ];
  return rig.bodyTransform(...(mirror ? [mirror - p[0], p[1]] : p));
}

export function renderNativeAssembly(rig) {
  rig.renderer.begin(rig.width, rig.height);
  rig.drawOrder = [];
  const draw = (name, transform, opacity = 1) => {
    const sprite = rig.sprites[name];
    if (!sprite) return;
    sprite.opacity = opacity;
    if (opacity < 0.001 || !rig.matchesInspection(name)) return;
    rig.renderer.draw(sprite, (x, y, u, v) => {
      const p = transform(x, y, u, v);
      return [
        p[0] * rig.scale + rig.offset[0],
        p[1] * rig.scale + rig.offset[1],
      ];
    });
    // Picking retains the actual per-pass depth state. A hand's wrist and
    // fingers can occupy different sides of a cuff without duplicating art.
    rig.drawOrder.push({ ...sprite });
  };
  const closure = rig.eyeClosure(),
    head = (x, y) => rig.headTransform(x, y),
    body = (x, y) => rig.bodyTransform(x, y);
  const earlyCuffs = new Set();
  const contexts = Object.fromEntries(
    ["left", "right"].map((side) => [side, cacheArm(armContext(rig, side))]),
  );
  for (const side of ["left", "right"]) {
    const context = contexts[side],
      mirror = context.manifest.mirror;
    if (context.manifest.poseArt)
      for (const suffix of [
        "-coat-back",
        "-coat-front",
        "-cuff-back",
        "-cuff-front",
        "-elbow-frill",
        "-hand",
      ]) {
        const sprite = rig.sprites[context.prefix + suffix];
        if (sprite) {
          rig.renderer.selectPoseKey(sprite, context.pose);
          if (sprite.cuffCurrent) {
            const offset = forearmFrame(context).waveOffset || 0;
            sprite.cuffCurrent.centre = rotate(
              ...sprite.cuffCurrent.centre,
              ...samplePoseArt(context).elbow,
              offset,
            );
            sprite.cuffCurrent.angle += offset;
          }
        }
      }
    for (const suffix of ["-coat-back", "-coat-front", "-elbow-frill"]) {
      const part = rig.sprites[context.prefix + suffix];
      if (part?.second && !part.poseKey) part.mix = clothTurn(context);
    }
    context.clothOpening =
      rig.sprites[context.prefix + "-cuff-front"]?.cuffCurrent;
    rig.nativeCloth[side].solve(context, (x, y) => {
      const p = nativeClothPoint(context, mirror ? mirror - x : x, y);
      return mirror ? [mirror - p[0], p[1]] : p;
    });
  }
  const foregroundCoats = () => {
    for (const side of ["left", "right"]) {
      const context = contexts[side],
        front = smoothstep(0.06, 0.3, context.pose),
        prefix = context.prefix;
      if (front < 0.001) continue;
      for (const suffix of context.manifest.armPoseMaterials?.version >= 3
        ? ["-coat-back", "-cuff-back"]
        : ["-lining", "-coat-back"]) {
        let vertex = 0;
        const panel = rig.nativeCloth[side];
        const sprite = rig.sprites[prefix + suffix];
        if (!sprite) continue;
        if (sprite.poseKey) {
          sprite.frontDepth = coatDepth(context);
        }
        draw(
          prefix + suffix,
          () => {
            const p =
              suffix === "-cuff-back" &&
              !sprite.registeredGarment &&
              !sprite.sharedGarment
                ? body(sprite.rest[vertex * 2], sprite.rest[vertex * 2 + 1])
                : body(
                    panel.position[vertex * 2],
                    panel.position[vertex * 2 + 1],
                  );
            vertex++;
            return p;
          },
          (sprite.poseKey ? 1 : front) *
            (suffix === "-lining" ? smoothstep(0.04, 0.22, context.pose) : 1),
        );
        sprite.frontDepth = null;
      }
    }
  };
  const drawHandLayer = (context, mode) => {
    const name = context.prefix + "-hand",
      sprite = rig.sprites[name],
      source = context.manifest.poseArt[0],
      mirror = context.manifest.mirror,
      [x, y, w, h] = sprite.rect,
      c = Math.cos(source.handAngle),
      s = Math.sin(source.handAngle),
      cut = mix(28, -8, smoothstep(0, 0.32, context.pose));
    sprite.handDepth = [
      ((mirror ? mirror - x : x) - source.wrist[0]) * c +
        (y - source.wrist[1]) * s -
        cut,
      (mirror ? -1 : 1) * w * c,
      h * s,
      mode,
    ];
    draw(name, (x, y) => {
      const p = poseHandPoint(context, mirror ? mirror - x : x, y);
      return body(...(mirror ? [mirror - p[0], p[1]] : p));
    });
    sprite.handDepth = null;
  };
  const coatDepth = (context, back = false) => {
    if (smoothstep(0.06, 0.3, context.pose) < 0.001) return null;
    const frame = forearmFrame(context),
      mirror = context.manifest.mirror,
      origin = body(
        mirror ? mirror - frame.origin[0] : frame.origin[0],
        frame.origin[1],
      ),
      tip = body(
        (mirror ? -1 : 1) * Math.cos(frame.angle) +
          (mirror ? mirror - frame.origin[0] : frame.origin[0]),
        Math.sin(frame.angle) + frame.origin[1],
      ),
      dx = tip[0] - origin[0],
      dy = tip[1] - origin[1],
      norm = Math.hypot(dx, dy);
    return {
      axis: [
        origin[0] * rig.scale + rig.offset[0],
        origin[1] * rig.scale + rig.offset[1],
        dx / norm / rig.scale,
        dy / norm / rig.scale,
      ],
      cut: mix(160, -260, smoothstep(0.02, 0.42, context.pose)),
      back,
    };
  };
  for (const name of rig.manifest.referenceAssembly.order) {
    if (name === "arm-elbow-frill") foregroundCoats();
    const sprite = rig.sprites[name];
    if (earlyCuffs.has(name)) continue;
    if (name === "eye-edge-observation") {
      draw(name, head, 1 - smoothstep(0, 0.6, closure));
      continue;
    }
    if (name.startsWith("eye-")) {
      const side = name.split("-").at(-1),
        base = rig.manifest.faceRig.eyes[side],
        shape = eyeShape(rig, side, closure);
      if (name.startsWith("eye-seat-")) {
        draw(name, head, 1 - smoothstep(0, 0.72, closure));
      } else if (name.startsWith("eye-fold-")) {
        // The original coloured lid crease is a feature, not permanent skin.
        // It relaxes while the upper lid closes; no open-eye crease is left
        // printed on the blank plate above a closed lash.
        const angle = rig.manifest.faceRig.head.angle;
        draw(
          name,
          (x, y) =>
            head(
              x - Math.sin(angle) * closure * 2,
              y + Math.cos(angle) * closure * 2,
            ),
          1 - smoothstep(0.02, 0.7, closure),
        );
      } else if (
        name.startsWith("eye-white-") ||
        name.startsWith("eye-iris-")
      ) {
        sprite.aperture = closure > 0.00001 ? apertureMask(rig, shape) : null;
        draw(
          name,
          (x, y) => {
            if (name.startsWith("eye-iris-")) {
              const gaze = shape.irisX - base.iris[0],
                a = rig.manifest.faceRig.head.angle;
              x += gaze * Math.cos(a);
              y += gaze * Math.sin(a);
            }
            return head(x, y);
          },
          1 - smoothstep(0.97, 1, closure),
        );
      } else if (name.startsWith("eye-lower-")) {
        draw(
          name,
          (x, y) => {
            const p = headLocal(rig, x, y),
              u = (p[0] - base.x) / base.width;
            p[1] += at(shape.lower, u) - at(base.lower, u);
            return head(...faceWorld(rig, ...p));
          },
          1 - smoothstep(0.45, 0.96, closure),
        );
      } else if (name.startsWith("eye-upper-")) {
        sprite.mix = closure;
        const move = (x, y, closed) => {
          const p = headLocal(rig, x, y),
            u = (p[0] - base.x) / base.width;
          p[1] += at(shape.upper, u) - at(closed ? base.closed : base.upper, u);
          return head(...faceWorld(rig, ...p));
        };
        draw(name, (x, y) => move(x, y, false));
      }
      continue;
    }
    if (name === "mouth-seat") {
      const shape = mouthShape(rig);
      draw(name, head, clamp(shape.opening, 0, 1) * (1 - shape.round));
      continue;
    }
    if (name === "mouth-cavity") {
      const base = rig.manifest.faceRig.mouth,
        shape = mouthShape(rig),
        annoyed = rig.getEmotionWeights().annoyed;
      sprite.mix = 1 - clamp(shape.opening, 0, 1);
      sprite.roundMix = shape.round;
      draw(name, (x, y) => {
        const p = headLocal(rig, x, y),
          u = (p[0] - base.x) / base.width;
        const mid = Math.floor(base.upper.length / 2),
          centre = base.y + (base.upper[mid] + base.lower[mid]) * 0.5,
          extra = Math.max(1, shape.opening);
        return head(
          ...faceWorld(
            rig,
            shape.x + u * shape.width,
            centre +
              (p[1] - centre) * extra +
              annoyed *
                (1 - Math.sin(Math.PI * clamp(u, 0, 1))) *
                6 *
                sprite.mix,
          ),
        );
      });
      continue;
    }
    if (name.startsWith("arm")) {
      const side = name.startsWith("arm-right") ? "right" : "left",
        context = contexts[side],
        mirror = context.manifest.mirror;
      if (rig.manifest.parts[name].armMaterialReveal)
        sprite.mix = smoothstep(0.005, 0.13, context.pose);
      if (sprite.poseKey) {
        if (name.endsWith("-hand")) {
          drawHandLayer(
            context,
            rig.sprites[context.prefix + "-cuff-front"] ? 1 : 0,
          );
        } else if (name.includes("-coat-") || name.endsWith("-elbow-frill")) {
          let vertex = 0;
          const panel = rig.nativeCloth[side];
          if (name.endsWith("-coat-back"))
            sprite.frontDepth = coatDepth(context, true);
          draw(name, () =>
            body(panel.position[vertex * 2], panel.position[vertex++ * 2 + 1]),
          );
          sprite.frontDepth = null;
        } else {
          if (name.endsWith("-cuff-front")) drawHandLayer(context, 2);
          if (name.endsWith("-cuff-back"))
            sprite.frontDepth = coatDepth(context, true);
          if (sprite.registeredGarment || sprite.sharedGarment) {
            let vertex = 0;
            const panel = rig.nativeCloth[side];
            draw(name, () =>
              body(
                panel.position[vertex * 2],
                panel.position[vertex++ * 2 + 1],
              ),
            );
          } else draw(name, body);
          sprite.frontDepth = null;
        }
        continue;
      }
      if (name.endsWith("-hand")) {
        const binding = rig.nativeHands[side];
        if (binding.bones) {
          const targets = handSurfaceTargets(context, binding.fingers);
          let vertex = 0;
          sprite.mix = handTurn(context);
          draw(name, (x, y) => {
            const p = skinHandPoint(
              mirror ? mirror - x : x,
              y,
              binding.weights[vertex++],
              binding.bones,
              targets,
            );
            return body(...(mirror ? [mirror - p[0], p[1]] : p));
          });
          continue;
        }
        const targets = [
          palmPoint(context, 0.17, 0),
          palmPoint(context, 0.83, 0),
        ];
        for (const v of [0, 1])
          for (const digit of binding.fingers)
            targets.push(fingerPoint(context, digit, 0.5, v));
        let vertex = 0;
        sprite.mix = handTurn(context);
        draw(name, (x, y) => {
          const p = binding.warp.point(
            mirror ? mirror - x : x,
            y,
            binding.weights[vertex++],
            targets,
          );
          return body(...(mirror ? [mirror - p[0], p[1]] : p));
        });
      } else if (name.endsWith("-forearm")) {
        sprite.mix = handTurn(context);
        const frame = forearmFrame(context);
        if (context.manifest.forearmArc) {
          const art = samplePoseArt(context),
            cuff = rig.sprites[context.prefix + "-cuff-front"].cuffCurrent;
          sprite.forearmMouth = {
            frame,
            cuff,
            exit: Math.hypot(
              art.cuff[0] - art.elbow[0],
              art.cuff[1] - art.elbow[1],
            ),
          };
        }
        const source = context.armModel.forearm.rest;
        const cuffLength = nativeCuffLength(context, frame);
        const overlap = 4 * smoothstep(0.04, 0.18, context.pose);
        sprite.clipFrom = clamp((cuffLength - overlap) / frame.length, 0, 1);
        draw(
          name,
          (_x, _y, u, v) => {
            const p = framePoint(frame, u, v);
            return body(...(mirror ? [mirror - p[0], p[1]] : p));
          },
          smoothstep(0, 0.04, context.pose),
        );
        // The near rim occludes the forearm, while the hand remains in front
        // of it. Drawing this entire rim after all digits cut across fingers
        // when the broad opening turned obliquely during the lift.
        if (context.pose > 1e-5) {
          let vertex = 0;
          const cuff = context.prefix + "-coat-front",
            panel = rig.nativeCloth[side];
          draw(cuff, () =>
            body(panel.position[vertex * 2], panel.position[vertex++ * 2 + 1]),
          );
          earlyCuffs.add(cuff);
        }
      } else if (name.includes("-finger-") || name.endsWith("-palm")) {
        sprite.surfaceReveal = sprite.nativeHandVisibility
          ? smoothstep(0.015, 0.3, context.pose)
          : 1;
        // A lifted hand exposes its complete wrist and finger roots before
        // the palmar turn starts. Keeping the cropped contact endpoint until
        // pose .25 left a visible gap between the new forearm and the palm.
        sprite.mix = name.includes("-complete-")
          ? 0
          : clamp(
              handTurn(context) + smoothstep(0, 0.08, context.pose) * 0.01,
              0,
              1,
            );
        const opacity = name.includes("-complete-")
          ? 1 - smoothstep(0.05, 0.45, handTurn(context))
          : 1;
        if (name.endsWith("-palm")) {
          const binding = rig.nativePalms[side];
          if (binding.affine) {
            draw(
              name,
              (x, y) => handPoint(rig, context, side, name, x, y),
              opacity,
            );
            continue;
          }
          const targets = [
            palmPoint(context, 0.17, 0),
            palmPoint(context, 0.83, 0),
            ...binding.fingers.map((digit) =>
              fingerPoint(context, digit, 0.5, 0),
            ),
          ];
          let vertex = 0;
          draw(
            name,
            (x, y) => {
              const p = binding.warp.point(
                mirror ? mirror - x : x,
                y,
                binding.weights[name][vertex++],
                targets,
              );
              return body(...(mirror ? [mirror - p[0], p[1]] : p));
            },
            opacity,
          );
        } else
          draw(
            name,
            (x, y) => handPoint(rig, context, side, name, x, y),
            opacity,
          );
      } else if (
        name.endsWith("-coat-back") ||
        name.endsWith("-coat-front") ||
        name.endsWith("-lining")
      ) {
        let vertex = 0;
        const panel = rig.nativeCloth[side];
        draw(
          name,
          (x, y) => {
            const p = [
              panel.position[vertex * 2],
              panel.position[vertex * 2 + 1],
            ];
            vertex++;
            return body(...p);
          },
          name.endsWith("-lining") ? smoothstep(0.04, 0.22, context.pose) : 1,
        );
      } else if (name.endsWith("-elbow-frill"))
        draw(name, (x, y) => {
          const p = sleeveFrillPoint(context, mirror ? mirror - x : x, y);
          return body(...(mirror ? [mirror - p[0], p[1]] : p));
        });
      else
        draw(
          name,
          (x, y) => {
            const p = upperArmPoint(context, mirror ? mirror - x : x, y);
            return body(...(mirror ? [mirror - p[0], p[1]] : p));
          },
          name.endsWith("-upper-hidden")
            ? smoothstep(0.02, 0.18, context.pose)
            : 1,
        );
      continue;
    }
    if (name === "hair-rear" || name === "hair-curtain")
      draw(name, (x, y) => {
        const left = rig.hairTransform(x, y, "left"),
          right = rig.hairTransform(x, y, "right"),
          weight = smoothstep(566, 670, x);
        return [mix(left[0], right[0], weight), mix(left[1], right[1], weight)];
      });
    else if (name.startsWith("hair-back-") || name.startsWith("hair-side-"))
      draw(name, (x, y) => rig.hairTransform(x, y, name.split("-").at(-1)));
    else if (name.startsWith("hair-front-"))
      draw(name, (x, y) =>
        rig.hairTransform(x, y, name.split("-").at(-1), true),
      );
    else if (name === "hair-crown") {
      if (rig.manifest.parts[name].skinFringeCorrective)
        sprite.mix = smoothstep(0, 0.65, closure);
      draw(name, (x, y) => rig.crownTransform(x, y));
    } else if (name === "hat" || name === "hat-brim")
      draw(name, (x, y) => rig.hatTransform(x, y));
    else if (name === "pompom") draw(name, (x, y) => rig.pompomTransform(x, y));
    else if (name.startsWith("leg-contact-")) {
      const side = name.split("-").at(-1),
        context = contexts[side];
      draw(
        name,
        (x, y) => rig.legTransform(x, y, side),
        1 - smoothstep(0.005, 0.055, context.pose),
      );
    } else if (name.startsWith("leg-") || name.startsWith("boot-")) {
      if (rig.manifest.parts[name].legOcclusionCorrective)
        sprite.mix =
          1 - smoothstep(0, 0.08, contexts[name.split("-").at(-1)].pose);
      draw(name, (x, y) => rig.legTransform(x, y, name.split("-").at(-1)));
    } else if (name === "neck" || name === "neck-front")
      draw(name, (x, y) => {
        const a = head(x, y),
          b = body(x, y),
          t = smoothstep(300, 346, y);
        return [mix(a[0], b[0], t), mix(a[1], b[1], t)];
      });
    else if (name === "face" || name.startsWith("ear-")) {
      if (rig.manifest.parts[name].skinFringeCorrective)
        sprite.mix = smoothstep(0, 0.65, closure);
      draw(name, head);
    } else if (name.startsWith("shoulder-frill-")) {
      const side = name.split("-").at(-1),
        context = contexts[side],
        mirror = context.manifest.mirror;
      draw(name, (x, y) => {
        const canonicalX = mirror ? mirror - x : x;
        // The inner ruffle is sewn to the collar. Rotating the entire plate
        // pulled its concealed collar continuation into the neck and hair.
        const free =
          (1 - smoothstep(530, 564, canonicalX)) * smoothstep(325, 355, y);
        const p = rotate(
          canonicalX,
          y,
          ...context.manifest.upperArm.shoulder,
          upperArmAngle(context) * free * 0.2,
        );
        return body(...(mirror ? [mirror - p[0], p[1]] : p));
      });
    } else if (name.startsWith("bow-"))
      draw(name, (x, y) => {
        const side = name.endsWith("left") ? -1 : 1,
          tail = name.includes("tail");
        const angle =
          rig.ribbon.value * side * (tail ? 1 : 0.35) * smoothstep(385, 480, y);
        return body(...rotate(x, y, 616, 382, angle));
      });
    else draw(name, body);
  }
  rig.pompomPosition = rig.pompomAnchor();
  rig.emit("frame", {
    time: rig.time,
    pose: rig.pose,
    emotion: rig.emotion,
    drawCalls: rig.renderer.drawCalls,
    head: rig.head.value,
    hair: rig.hairLeft[2].value,
    pompom: rig.pompomPosition,
  });
}
