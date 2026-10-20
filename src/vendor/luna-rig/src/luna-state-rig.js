import { LunaRig } from "./luna-rig.js";
import {
  StateSpriteTransition,
  STATE_TRANSITION,
} from "./state-sprite-transition.js";
export { EMOTIONS, ZONE_LABELS } from "./luna-rig.js";

/** Presentation adapter; the original layered rig and its materials stay intact. */
export class LunaStateRig extends LunaRig {
  constructor(canvas, options = {}) {
    super(canvas, options);
    this.poseState = { pose: 0, side: this.waveSide };
    this.canvas.dataset.lunaState = "idle";
    this.requestedPoseState = this.poseState;
    this.returnAt = 0;
    this.stateSprites = new StateSpriteTransition(canvas, {
      suspended: this.paused || this.visibilityHidden,
      gl: this.renderer.gl,
      reservedAttributes: [this.renderer.position, this.renderer.uv],
    });
    this.listen(document, "visibilitychange", () => this.syncStatePause());
  }

  async load() {
    await super.load();
    this.poseState = { pose: 0, side: this.waveSide };
    this.requestedPoseState = this.poseState;
    this.pinPose();
  }

  render() {
    super.render();
    if (
      this.stateSprites?.visible &&
      !this.stateSprites.suppressed &&
      this.stateSprites.phase !== "preparing"
    ) {
      this.stateSprites.captureCurrent();
      this.stateSprites.renderMix();
    }
  }

  snapshot(pose = 0) {
    if (!this.stateSprites) return super.snapshot(pose);
    this.stateSprites.suppressed = true;
    try {
      return super.snapshot(pose);
    } finally {
      this.stateSprites.suppressed = false;
      this.render();
    }
  }

  pinPose() {
    const { pose, side } = this.poseState;
    this.manualPose = true;
    this.waveUntil = 0;
    this.pose = this.poseTarget = pose;
    for (const arm of ["left", "right"]) {
      this.armPoses[arm].reset(arm === side ? pose : 0);
      this.armGestures[arm].reset();
    }
  }

  commitPose(state) {
    this.poseState = state;
    this.canvas.dataset.lunaState = state.pose ? "wave" : "idle";
    this.pinPose();
    for (const spring of Object.values(this.sleeveLags)) spring.reset();
    if (state.side !== this.waveSide) super.setWaveSide(state.side);
    else this.render();
    this.emit("pose-state", {
      state: state.pose ? "wave" : "idle",
      side: state.side,
    });
  }

  switchPose(pose, side, immediate = false) {
    if (!["left", "right"].includes(side))
      throw new RangeError(
        "Wave side must be left or right in screen coordinates",
      );
    const state = { pose, side };
    const previous = this.requestedPoseState;
    if (!immediate && previous.pose === pose && previous.side === side)
      return this.poseTransition || Promise.resolve(true);
    this.requestedPoseState = state;
    this.poseTransition = this.stateSprites.show(() => this.commitPose(state), {
      immediate,
      skip: () => this.poseState.pose === pose && this.poseState.side === side,
      region: () => this.transitionRegion(),
    });
    // UI event handlers need not await the transition, but failures must remain visible.
    this.poseTransition.catch((error) =>
      this.emit("error", { message: error.message }),
    );
    return this.poseTransition;
  }

  transitionRegion() {
    const dpr = this.canvas.width / this.width;
    const rect = (left, top, right, bottom) => [
      (left * this.scale + this.offset[0]) * dpr,
      (top * this.scale + this.offset[1]) * dpr,
      (right - left) * this.scale * dpr,
      (bottom - top) * this.scale * dpr,
    ];
    return {
      rect: rect(300, 210, 940, 805),
      exclude: rect(490, 100, 718, 300),
      feather: 3 * this.scale * dpr,
    };
  }

  setPose(value, immediate = false) {
    this.returnAt = 0;
    return this.switchPose(
      Number(value) >= 0.5 ? 1 : 0,
      this.requestedPoseState.side,
      immediate,
    );
  }

  setWaveSide(side) {
    if (!this.ready || !this.stateSprites) return super.setWaveSide(side);
    return this.switchPose(this.requestedPoseState.pose, side);
  }

  waveHello(duration = 4, side = this.requestedPoseState.side) {
    if (this.paused) this.setPaused(false);
    this.returnAt = this.time + Math.max(0.25, Number(duration) || 4);
    const transition = this.switchPose(1, side);
    this.emit("action", {
      action: "wave",
      message: "Приветствие · смена позы",
    });
    return transition;
  }

  update(dt) {
    if (this.returnAt && this.time + dt >= this.returnAt) {
      this.returnAt = 0;
      void this.switchPose(0, this.requestedPoseState.side);
    }
    if (this.poseState) this.pinPose();
    super.update(dt);
  }

  reset(immediate = false) {
    if (!this.stateSprites) return super.reset(immediate);
    this.returnAt = 0;
    const transition = this.switchPose(
      0,
      this.requestedPoseState.side,
      immediate,
    );
    super.reset(immediate);
    this.pinPose();
    return transition;
  }

  syncStatePause() {
    this.stateSprites?.setSuspended(
      this.paused || this.visibilityHidden || this.suspensions.size > 0,
    );
  }

  setPaused(value) {
    super.setPaused(value);
    this.syncStatePause();
  }

  setSuspended(reason, suspended) {
    super.setSuspended(reason, suspended);
    this.syncStatePause();
  }

  getState() {
    return {
      ...super.getState(),
      poseState: this.poseState.pose ? "wave" : "idle",
      requestedPoseState: this.requestedPoseState.pose ? "wave" : "idle",
      poseTransition: {
        ...STATE_TRANSITION,
        phase: this.stateSprites.phase || "idle",
      },
    };
  }

  destroy() {
    this.stateSprites?.destroy();
    super.destroy();
  }
}
