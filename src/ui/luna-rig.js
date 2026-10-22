import { LunaStateRig } from '../vendor/luna-rig/src/luna-state-rig.js';

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
    const boot = this.sprites['boot-right'], part = this.manifest.parts['boot-right'];
    const { main, tip } = splitBootTip(boot.alpha, boot.imageWidth, boot.imageHeight);
    const gl = this.renderer.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, boot.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, boot.imageWidth, boot.imageHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, main);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    boot.alpha = main;
    this.sprites['boot-tip-left'] = this.renderer.makeSprite({ width: boot.imageWidth, height: boot.imageHeight, pixels: tip }, part.rect, {
      name: 'boot-tip-left', zone: 'legs', columns: part.columns, rows: part.rows, raw: true, mipmaps: false, nativePixels: true,
    });
    this.manifest.parts['boot-tip-left'] = { ...part };
    const order = this.manifest.referenceAssembly.order;
    order.splice(order.indexOf('boot-right'), 0, 'boot-tip-left');
    this.render();
  }
}
