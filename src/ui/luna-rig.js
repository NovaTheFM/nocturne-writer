import { LunaStateRig } from '../vendor/luna-rig/src/luna-state-rig.js';
import { rgbaPng } from '../vendor/luna-rig/src/png-rgba.js';
import { LunaPoseTransition, LUNA_POSE_MOTION } from './luna-pose-transition.js';

export function cleanHairFringe(pixels, width, height) {
  const clean = new Uint8Array(pixels), candidates = new Uint8Array(width * height), pending = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // The crescent and star are intentionally pale; only the cutout's skin/white fringe is foreign paint.
    if (x >= 26 && x <= 89 && y >= 61 && y <= 126 || x >= 29 && x <= 68 && y >= 121 && y <= 154) continue;
    const index = y * width + x, offset = index * 4, alpha = pixels[offset + 3];
    if (!alpha) continue;
    const r = pixels[offset] * 255 / alpha, g = pixels[offset + 1] * 255 / alpha, b = pixels[offset + 2] * 255 / alpha;
    if (Math.min(r, g, b) < 110 || b - r > 14 || b - g > 28) continue;
    candidates[index] = 1;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || [index - 1, index + 1, index - width, index + width].some(i => pixels[i * 4 + 3] < 16)) pending.push(index);
  }
  while (pending.length) {
    const index = pending.pop();
    if (!candidates[index]) continue;
    candidates[index] = 0; clean.fill(0, index * 4, index * 4 + 4);
    const x = index % width, y = Math.floor(index / width);
    if (x) pending.push(index - 1);
    if (x + 1 < width) pending.push(index + 1);
    if (y) pending.push(index - width);
    if (y + 1 < height) pending.push(index + width);
  }
  return clean;
}

export function bindHatOutline(hair, hairWidth, hat, hatWidth) {
  const cleanHair = new Uint8Array(hair), completeHat = new Uint8Array(hat);
  for (let y = 0; y < 90; y++) for (let x = 460; x < 505; x++) {
    const source = (y * hairWidth + x) * 4, target = ((y + 47) * hatWidth + x - 177) * 4;
    const uncovered = 1 - completeHat[target + 3] / 255;
    for (let channel = 0; channel < 4; channel++) completeHat[target + channel] = Math.min(255, Math.round(completeHat[target + channel] + hair[source + channel] * uncovered));
    cleanHair.fill(0, source, source + 4);
  }
  return { hair: cleanHair, hat: completeHat };
}

export function splitBootTip(pixels, width, height) {
  const main = new Uint8Array(pixels), tip = new Uint8Array(pixels.length);
  // This disconnected island belongs to the left shoe in the published material.
  for (let y = 0; y < height; y++) for (let x = 0; x < Math.min(16, width); x++) {
    const offset = (y * width + x) * 4;
    tip.set(main.subarray(offset, offset + 4), offset);
    main.fill(0, offset, offset + 4);
  }
  return { main, tip };
}

export class LunaAppRig extends LunaStateRig {
  constructor(canvas, options = {}) {
    super(canvas, options);
    this.stateSprites.destroy();
    this.stateSprites = new LunaPoseTransition(canvas, {
      suspended: this.paused || this.visibilityHidden, gl: this.renderer.gl,
      reservedAttributes: [this.renderer.position, this.renderer.uv],
    });
  }

  pinPose() {
    if (!this.poseState) return;
    const { pose, side } = this.poseState;
    this.manualPose = true; this.waveUntil = 0;
    this.pose = this.poseTarget = pose;
    for (const arm of ['left', 'right']) {
      this.armPoses[arm].reset(arm === side ? pose : 0);
      this.armGestures[arm].reset(arm === side ? pose * 3.3 * this.options.motion : 0);
    }
  }

  getState() {
    const state = super.getState();
    return { ...state, poseTransition: { ...state.poseTransition, ...LUNA_POSE_MOTION } };
  }

  upload(sprite, pixels, texture = sprite.texture) {
    const gl = this.renderer.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, sprite.imageWidth, sprite.imageHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (texture === sprite.texture) sprite.alpha = pixels;
  }

  resize() {
    super.resize();
    const ratio = Math.min(3, Math.max(2, (window.devicePixelRatio || 1) * 1.5));
    const width = Math.round(this.width * ratio), height = Math.round(this.height * ratio);
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width; this.canvas.height = height;
    if (this.ready) this.render();
  }

  async load() {
    await super.load();
    const rear = this.sprites['hair-rear'], hat = this.sprites.hat;
    const bound = bindHatOutline(rear.alpha, rear.imageWidth, hat.alpha, hat.imageWidth);
    for (const name of ['hair-rear', 'hair-curtain']) this.upload(this.sprites[name], bound.hair);
    for (const name of ['hat', 'hat-brim']) this.upload(this.sprites[name], bound.hat);
    const crown = this.sprites['hair-crown'];
    this.upload(crown, cleanHairFringe(crown.alpha, crown.imageWidth, crown.imageHeight));
    const side = await rgbaPng(new URL(this.manifest.parts['hair-crown'].side, this.assets));
    this.upload(crown, cleanHairFringe(side.pixels, side.width, side.height), crown.sideTexture);
    const boot = this.sprites['boot-right'], part = this.manifest.parts['boot-right'];
    const { main, tip } = splitBootTip(boot.alpha, boot.imageWidth, boot.imageHeight);
    this.upload(boot, main);
    this.sprites['boot-tip-left'] = this.renderer.makeSprite({ width: boot.imageWidth, height: boot.imageHeight, pixels: tip }, part.rect, {
      name: 'boot-tip-left', zone: 'legs', columns: part.columns, rows: part.rows, raw: true, mipmaps: false, nativePixels: true,
    });
    this.manifest.parts['boot-tip-left'] = { ...part };
    const order = this.manifest.referenceAssembly.order;
    order.splice(order.indexOf('boot-right'), 0, 'boot-tip-left');
    this.render();
  }
}
