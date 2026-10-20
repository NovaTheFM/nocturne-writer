import { clamp, mix } from "./math.js";

/** The same two rigid bones used to register the authored observations. */
export function articulatedFrame(model, pose) {
  const t = clamp(pose, 0, 1),
    angle = mix(...model.angles, t);
  let elbow = model.elbow;
  if (model.shoulder) {
    const upper = mix(...model.upperAngles, t);
    elbow = [
      model.shoulder[0] + model.upperLength * Math.cos(upper),
      model.shoulder[1] + model.upperLength * Math.sin(upper),
    ];
  }
  return {
    elbow,
    angle,
    wrist: [
      elbow[0] + model.length * Math.cos(angle),
      elbow[1] + model.length * Math.sin(angle),
    ],
  };
}
