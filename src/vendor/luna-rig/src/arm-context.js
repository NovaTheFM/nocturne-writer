/** Each limb owns its reference joints, textures and independent pose spring. */
export function armContext(rig, side = "right") {
  const source = rig.manifest.arms?.[side];
  if (!source) return side === "left" ? rig : null;
  const context = Object.create(rig);
  context.manifest = { ...rig.manifest, ...source };
  context.armModel = source.arm;
  context.pose = side === rig.waveSide ? rig.pose : rig.armPoses[side].value;
  context.waveGesture = rig.armGestures[side];
  context.sleeveLag =
    rig.sleeveLags?.[side] ||
    (side === rig.waveSide ? rig.sleeveLag : { value: 0 });
  context.prefix = side === "right" ? "arm-right" : "arm";
  context.toWorld = (point) =>
    source.mirror ? [source.mirror - point[0], point[1]] : point;
  return context;
}
