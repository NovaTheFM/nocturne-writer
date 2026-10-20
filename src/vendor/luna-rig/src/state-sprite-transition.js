import { FrameClock } from "./frame-clock.js";
import { SpriteBlendSurface } from "./sprite-blend-surface.js";

export const STATE_TRANSITION = Object.freeze({
  duration: 250,
  easing: "ease",
});

export class StateSpriteTransition {
  constructor(canvas, { suspended = false, surface, ...graphics } = {}) {
    this.canvas = canvas;
    this.front = canvas;
    this.surface = surface || new SpriteBlendSurface(canvas, graphics);
    this.suspended = suspended;
    this.version = 0;
    this.phase = "idle";
    this.canvas.dataset.lunaTransition = "idle";
    this.clock = new FrameClock(60);
  }

  show(commit, { immediate = false, skip = () => false, region = null } = {}) {
    if (this.destroyed) return Promise.resolve(false);
    if (immediate) {
      this.cancel();
      commit();
      return Promise.resolve(true);
    }
    this.pending?.resolve(false);
    const result = new Promise((resolve, reject) => {
      this.pending = { commit, skip, region, resolve, reject };
    });
    if (!this.queued) {
      this.queued = true;
      queueMicrotask(() => {
        this.queued = false;
        const request = this.pending;
        this.pending = null;
        if (request && !this.destroyed) this.begin(request);
      });
    }
    return result;
  }

  begin(request) {
    if (!this.visible && request.skip()) {
      request.resolve(true);
      return;
    }
    if (this.visible) this.renderMix();
    this.interrupt();
    const version = this.version;
    try {
      this.surface.capturePrevious();
      this.region = request.region;
      this.size = [this.canvas.width, this.canvas.height];
      this.progress = 0;
      this.visible = true;
      this.phase = "preparing";
      request.commit();
      // The commit already rendered its ready endpoint in this same context.
      this.captureCurrent();
      this.surface.captureReference();
      this.renderMix(0);
      this.resolve = request.resolve;
      this.phase = "fading";
      this.canvas.dataset.lunaTransition = "fading";
      this.animation = new Animation(
        new KeyframeEffect(null, [{ opacity: 1 }, { opacity: 0 }], {
          ...STATE_TRANSITION,
          fill: "both",
        }),
        document.timeline,
      );
      this.animation.play();
      if (this.suspended) this.animation.pause();
      this.startPainting();
      this.animation.finished.then(
        () => {
          if (version !== this.version) return;
          this.renderMix(1);
          this.clear();
          request.resolve(true);
        },
        (error) => {
          if (version !== this.version) return;
          this.clear();
          request.reject(error);
        },
      );
    } catch (error) {
      this.clear();
      request.reject(error);
    }
  }

  captureCurrent() {
    if (!this.visible || this.suppressed) return;
    this.surface.captureCurrent();
    if (
      this.phase === "fading" &&
      (this.canvas.width !== this.size[0] ||
        this.canvas.height !== this.size[1])
    ) {
      // A resized drawing buffer must never display a stretched old screenshot.
      this.animation.finish();
    }
  }

  renderMix(
    progress = this.animation?.effect.getComputedTiming().progress ??
      this.progress ??
      0,
  ) {
    if (!this.visible || this.suppressed) return;
    this.progress = progress;
    const region =
      typeof this.region === "function" ? this.region() : this.region;
    this.surface.draw(progress, region);
  }

  startPainting() {
    cancelAnimationFrame(this.paintHandle);
    if (!this.animation || this.suspended || this.destroyed) return;
    this.clock.reset();
    const paint = (now) => {
      this.paintHandle = 0;
      if (!this.animation || this.suspended || this.destroyed) return;
      if (this.clock.take(now) !== null) this.renderMix();
      this.paintHandle = requestAnimationFrame(paint);
    };
    this.paintHandle = requestAnimationFrame(paint);
  }

  setSuspended(suspended) {
    this.suspended = Boolean(suspended);
    if (!this.animation) return;
    if (this.suspended) {
      this.animation.pause();
      this.renderMix();
      cancelAnimationFrame(this.paintHandle);
      this.paintHandle = 0;
    } else {
      this.animation.play();
      this.startPainting();
    }
  }

  interrupt() {
    this.version++;
    this.resolve?.(false);
    this.resolve = null;
    this.animation?.cancel();
    this.animation = null;
    cancelAnimationFrame(this.paintHandle);
    this.paintHandle = 0;
  }

  clear() {
    cancelAnimationFrame(this.paintHandle);
    this.paintHandle = 0;
    this.animation = null;
    this.resolve = null;
    this.visible = false;
    this.phase = "idle";
    this.canvas.dataset.lunaTransition = "idle";
  }

  cancel() {
    if (this.visible) this.renderMix(1);
    this.interrupt();
    this.pending?.resolve(false);
    this.pending = null;
    this.clear();
  }

  destroy() {
    this.cancel();
    this.destroyed = true;
    this.surface.destroy();
  }
}
