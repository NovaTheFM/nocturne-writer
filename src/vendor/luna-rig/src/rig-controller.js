import { WebGLRenderer } from "./webgl.js";
import { Spring, clamp } from "./math.js";
import { sampleArticulation } from "./face-rig.js";
import { HatPhysics } from "./hat-physics.js";
import { HairChain } from "./hair-physics.js";
import { armContext } from "./arm-context.js";
import { limitArmPose } from "./hand-rig.js";
import { FrameClock } from "./frame-clock.js";

export const EMOTIONS = [
  "neutral",
  "happy",
  "shy",
  "annoyed",
  "surprised",
  "sleepy",
];
export const ZONE_LABELS = {
  hat: "Шапочка",
  pompom: "Помпон",
  hair: "Волосы",
  face: "Щёчки",
  chest: "Бант / грудь",
  hand: "Рука",
  legs: "Ноги",
};
export class RigController extends EventTarget {
  static async create(canvas, options = {}) {
    const rig = new this(canvas, options);
    try {
      await rig.load();
      return rig;
    } catch (error) {
      rig.destroy();
      throw error;
    }
  }
  constructor(
    canvas,
    {
      assets = new URL("../assets/", import.meta.url),
      autoStart = true,
      respectReducedMotion = true,
    } = {},
  ) {
    super();
    this.canvas = canvas;
    this.model = { width: 1243, height: 1265 };
    this.assets = new URL(assets, document.baseURI);
    this.autoStart = autoStart;
    this.renderer = new WebGLRenderer(canvas);
    this.sprites = {};
    this.drawOrder = [];
    this.options = {
      breathing: true,
      legs: true,
      blinking: true,
      tracking: true,
      physics: true,
      wind: 0.15,
      motion: 1,
      speed: 1,
      zoom: 1,
      maxFPS: 30,
    };
    this.time = 0;
    this.paused =
      respectReducedMotion &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.emotion = "neutral";
    this.expressions = Object.fromEntries(
      EMOTIONS.map((name) => [
        name,
        new Spring(name === "neutral" ? 1 : 0, 95, 20),
      ]),
    );
    this.talkEnvelope = new Spring(0, 95, 20);
    this.mouthOpening = new Spring(1, 650, 48);
    this.mouthWidth = new Spring(1, 220, 30);
    this.mouthRound = new Spring(0, 220, 30);
    this.pose = 0;
    this.poseTarget = 0;
    this.manualPose = false;
    this.talking = false;
    this.blinkAt = 2.3;
    this.blinkTime = -1;
    this.forcedBlink = false;
    this.expressionUntil = 0;
    this.waveUntil = 0;
    this.talkUntil = 0;
    this.head = new Spring(0, 45, 10);
    this.wave = new Spring(0, 35, 12);
    this.waveGesture = new Spring(0, 95, 20);
    this.waveSide = "right";
    this.armPoses = { left: new Spring(0, 35, 12), right: this.wave };
    this.armGestures = { left: new Spring(0, 95, 20), right: this.waveGesture };
    this.breathingSpring = new Spring(0, 75, 18);
    this.legAngles = {
      left: new Spring(0, 75, 18),
      right: new Spring(0, 75, 18),
    };
    this.hat = new Spring(0, 100, 9);
    this.hairChains = Object.fromEntries(
      ["back-left", "back-right", "front-left", "front-right"].map((name) => [
        name,
        new HairChain(name),
      ]),
    );
    this.hairLeft = this.hairChains["back-left"].x;
    this.hairRight = this.hairChains["back-right"].x;
    this.pomX = new Spring(0, 95, 9);
    this.pomY = new Spring(0, 95, 9);
    this.hatPhysics = new HatPhysics();
    this.ribbon = new Spring(0, 38, 8);
    this.sleeveLags = {
      left: new Spring(0, 38, 8),
      right: new Spring(0, 38, 8),
    };
    this.sleeveLag = this.sleeveLags[this.waveSide];
    this.recoil = new Spring(0, 110, 12);
    this.pointer = { x: 621, y: 260, inside: false };
    this.drag = null;
    this.hovered = null;
    this.frame = 0;
    this.lastFrame = null;
    this.frameClock = new FrameClock(this.options.maxFPS);
    this.animationRequested = false;
    this.visibilityHidden = document.hidden;
    this.destroyed = false;
    this.suspensions = new Set();
    this.listeners = [];
    this.listen(canvas, "pointermove", (e) => this.pointerMove(e));
    this.listen(canvas, "pointerdown", (e) => this.pointerDown(e));
    this.listen(canvas, "pointerup", (e) => this.pointerUp(e));
    this.listen(canvas, "pointercancel", (e) => this.cancelDrag(e));
    this.listen(canvas, "lostpointercapture", (e) => this.cancelDrag(e));
    this.listen(canvas, "pointerleave", () => {
      this.pointer.inside = false;
      if (!this.drag) this.setHover(null);
    });
    this.listen(canvas, "webglcontextlost", (e) => {
      e.preventDefault();
      cancelAnimationFrame(this.frame);
      this.emit("error", {
        message: "Графический контекст потерян. Нажмите «Перезагрузить».",
      });
    });
    this.listen(document, "visibilitychange", () => {
      this.lastFrame = null;
      this.visibilityHidden = document.hidden;
      this.frameClock.reset();
      this.syncAnimation();
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
  }
  listen(target, type, handler) {
    target.addEventListener(type, handler);
    this.listeners.push([target, type, handler]);
  }
  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.width * dpr),
      h = Math.round(this.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.scale =
      Math.min(this.width / this.model.width, this.height / this.model.height) *
      0.94 *
      this.options.zoom;
    this.offset = [
      (this.width - this.model.width * this.scale) / 2,
      (this.height - this.model.height * this.scale) / 2,
    ];
    if (Object.keys(this.sprites).length) this.render();
  }
  start() {
    this.animationRequested = true;
    this.frameClock.reset();
    this.syncAnimation();
  }
  syncAnimation() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (
      this.destroyed ||
      !this.animationRequested ||
      this.paused ||
      this.visibilityHidden ||
      this.suspensions.size
    )
      return;
    this.animationTick ||= (now) => {
      this.frame = 0;
      if (
        this.destroyed ||
        this.paused ||
        this.visibilityHidden ||
        this.suspensions.size
      )
        return;
      const dt = this.frameClock.take(now);
      if (dt !== null) {
        this.lastFrame = now;
        this.update(dt * this.options.speed);
        this.render();
      }
      this.frame = requestAnimationFrame(this.animationTick);
    };
    this.frame = requestAnimationFrame(this.animationTick);
  }
  setSuspended(reason, suspended) {
    if (suspended) this.suspensions.add(reason);
    else this.suspensions.delete(reason);
    this.frameClock.reset();
    this.syncAnimation();
  }
  configure(changes) {
    for (const key of ["breathing", "legs", "blinking", "tracking", "physics"])
      if (key in changes) this.options[key] = Boolean(changes[key]);
    for (const [key, min, max] of [
      ["wind", -1, 1],
      ["motion", 0, 1.8],
      ["speed", 0.1, 2],
      ["zoom", 0.7, 1.8],
      ["maxFPS", 12, 60],
    ]) {
      if (Number.isFinite(changes[key]))
        this.options[key] = clamp(changes[key], min, max);
    }
    if ("zoom" in changes) this.resize();
    if ("maxFPS" in changes) this.frameClock.setRate(this.options.maxFPS);
    if (this.paused && this.ready && !("zoom" in changes)) this.render();
  }
  setPaused(value) {
    this.paused = Boolean(value);
    this.lastFrame = null;
    this.frameClock.reset();
    this.syncAnimation();
    this.emit("pause", { paused: this.paused });
  }
  setEmotion(emotion, duration = Infinity, immediate = false) {
    if (!EMOTIONS.includes(emotion))
      throw new RangeError(`Unknown emotion: ${emotion}`);
    this.emotion = emotion;
    for (const [name, spring] of Object.entries(this.expressions)) {
      spring.target = name === emotion ? 1 : 0;
      if (immediate) spring.reset(spring.target);
    }
    this.expressionUntil = this.time + duration;
    this.emit("emotion", { emotion });
    this.render();
  }
  setPose(value, immediate = false) {
    this.manualPose = true;
    this.waveUntil = 0;
    this.poseTarget = clamp(Number(value) || 0, 0, 1);
    this.wave.target = this.poseTarget;
    if (immediate) {
      this.wave.reset(this.poseTarget);
      this.pose = this.poseTarget;
    }
    if (this.paused) {
      this.pose = this.poseTarget;
      this.wave.reset(this.pose);
      this.render();
    }
  }
  setWaveSide(side) {
    if (!["left", "right"].includes(side))
      throw new RangeError(
        "Wave side must be left or right in screen coordinates",
      );
    if (this.paused && side !== this.waveSide) {
      this.armPoses[this.waveSide].reset();
      this.armGestures[this.waveSide].reset();
      this.poseTarget = 0;
    }
    this.waveSide = side;
    this.wave = this.armPoses[side];
    this.waveGesture = this.armGestures[side];
    this.sleeveLag = this.sleeveLags[side];
    this.pose = this.wave.value;
    if (this.ready) this.resize();
  }
  blink() {
    if (this.paused) this.setPaused(false);
    this.blinkTime = this.time;
    this.forcedBlink = true;
    this.emit("action", { action: "blink", message: "Моргнула" });
  }
  waveHello(duration = 4, side = this.waveSide) {
    this.setWaveSide(side);
    if (this.paused) this.setPaused(false);
    this.manualPose = false;
    this.waveUntil = this.time + duration;
    this.poseTarget = 1;
    this.wave.target = 1;
    this.setEmotion("happy", duration);
    this.emit("action", {
      action: "wave",
      message: "Приветствие · плавное поднятие руки",
    });
  }
  startTalking(duration = Infinity) {
    if (this.paused) this.setPaused(false);
    this.talking = true;
    this.talkStart = this.time;
    this.talkUntil = this.time + Math.max(0.2, Number(duration) || Infinity);
    this.emit("action", { action: "talk", message: "Анимация рта включена" });
  }
  stopTalking() {
    if (this.paused) this.setPaused(false);
    this.talking = false;
    this.talkUntil = 0;
    this.emit("action", {
      action: "talk-stop",
      message: "Анимация рта завершается плавно",
    });
  }
  getEmotionWeights() {
    const entries = Object.entries(this.expressions).map(([name, spring]) => [
      name,
      Math.max(0, spring.value),
    ]);
    const sum = entries.reduce((total, [, value]) => total + value, 0) || 1;
    return Object.fromEntries(
      entries.map(([name, value]) => [name, value / sum]),
    );
  }
  react(zone, part = null) {
    if (!ZONE_LABELS[zone]) return;
    if (this.paused) this.setPaused(false);
    const messages = {
      hat: "Шапочка · пружинное встряхивание",
      pompom: "Помпон · упругий отклик",
      hair: "Волосы · инерция и смущение",
      face: "Лицо · улыбка и моргание",
      chest: "Недовольство · касание груди",
      hand: "Рука · приветствие",
      legs: "Недовольство · касание ног",
    };
    if (zone === "hat") {
      this.hat.kick(0.16);
      this.hatPhysics.kick(55, -90);
      this.setEmotion("surprised", 1.8);
    }
    if (zone === "pompom") {
      this.hatPhysics.kick(130, -100);
      this.setEmotion("surprised", 1.5);
    }
    if (zone === "hair") {
      this.hairLeft[2].kick(100);
      this.hairRight[2].kick(-80);
      this.setEmotion("shy", 2.5);
    }
    if (zone === "face") {
      this.setEmotion("happy", 2.5);
      this.head.kick(0.5);
      this.blink();
    }
    if (zone === "chest" || zone === "legs") {
      this.setEmotion("annoyed", 3);
      this.recoil.kick(70);
      this.head.kick(-0.6);
    }
    if (zone === "hand")
      this.waveHello(
        4,
        part
          ? /^(arm-right|hand-right)|^shoulder-frill-right$/.test(part)
            ? "right"
            : "left"
          : this.pointer.inside
            ? this.pointer.x > 619
              ? "right"
              : "left"
            : this.waveSide,
      );
    this.emit("reaction", { zone, message: messages[zone] });
  }
  update(dt) {
    this.time += dt;
    const t = this.time,
      amount = this.options.motion;
    if (t > this.expressionUntil && this.emotion !== "neutral")
      this.setEmotion("neutral");
    if (!this.manualPose && t > this.waveUntil) this.poseTarget = 0;
    if (this.talking && t > this.talkUntil) this.stopTalking();
    for (const spring of Object.values(this.expressions)) spring.step(dt);
    this.talkEnvelope.target = this.talking ? 1 : 0;
    this.talkEnvelope.step(dt);
    const weights = this.getEmotionWeights();
    const restOpening = weights.neutral + weights.happy + weights.surprised;
    const articulation = sampleArticulation(t - (this.talkStart || 0));
    const animatedOpening = articulation.opening;
    this.mouthOpening.target =
      restOpening * (1 - this.talkEnvelope.value) +
      animatedOpening * this.talkEnvelope.value;
    this.mouthOpening.step(dt);
    const restWidth =
      weights.neutral +
      weights.happy * 1.04 +
      weights.shy * 0.76 +
      weights.annoyed * 0.72 +
      weights.surprised * 0.48 +
      weights.sleepy * 0.74;
    this.mouthWidth.target =
      restWidth * (1 - this.talkEnvelope.value) +
      articulation.width * this.talkEnvelope.value;
    this.mouthRound.target =
      weights.surprised * (1 - this.talkEnvelope.value) +
      articulation.round * this.talkEnvelope.value;
    this.mouthWidth.step(dt);
    this.mouthRound.step(dt);
    for (const side of ["left", "right"]) {
      const spring = this.armPoses[side],
        previous = spring.value;
      spring.target = side === this.waveSide ? this.poseTarget : 0;
      spring.step(dt);
      if (this.manifest.referenceAssembly && dt > 0) {
        const limited = limitArmPose(
          armContext(this, side),
          previous,
          spring.value,
          dt,
        );
        if (limited !== spring.value) {
          spring.value = limited;
          spring.velocity = (limited - previous) / dt;
        }
      }
      this.armGestures[side].target =
        side === this.waveSide && !this.manualPose && t < this.waveUntil
          ? 1
          : 0;
      this.armGestures[side].step(dt);
    }
    this.pose = clamp(this.wave.value, 0, 1);
    if (this.options.blinking && t > this.blinkAt && this.blinkTime < 0) {
      this.blinkTime = t;
      this.blinkAt = t + 2.8 + Math.random() * 3;
    }
    if (this.blinkTime >= 0 && t - this.blinkTime > 0.22) {
      this.blinkTime = -1;
      this.forcedBlink = false;
    }
    this.breathingSpring.target = this.options.breathing
      ? Math.sin(t * 1.65) * 2.6 * amount
      : 0;
    this.breath = this.breathingSpring.step(dt);
    for (const [side, spring] of Object.entries(this.legAngles)) {
      spring.target = this.options.legs
        ? Math.sin(t * 1.4 + (side === "left" ? 0 : 1.2)) * 0.016 * amount
        : 0;
      spring.step(dt);
    }
    const gaze =
      this.options.tracking && this.pointer.inside
        ? clamp(
            (this.pointer.x - this.model.width / 2) / (this.model.width * 0.28),
            -1,
            1,
          ) * 0.05
        : 0;
    this.head.target =
      gaze +
      (Math.sin(t * 0.61) * 0.021 +
        weights.shy * -0.045 +
        weights.annoyed * 0.035) *
        amount;
    const lastAngle = this.head.value;
    this.head.step(dt);
    this.hat.step(dt);
    this.recoil.step(dt);
    const inertia = dt > 0 ? (-(this.head.value - lastAngle) / dt) * 40 : 0;
    const gust =
      this.options.wind *
      (1 + Math.sin(t * 1.1) * 0.4 + Math.sin(t * 2.1) * 0.18);
    for (const chain of Object.values(this.hairChains))
      chain.step(this, dt, gust);
    this.hatPhysics.step(dt, {
      drag: this.drag ? this.hatLocal(this.drag.x, this.drag.y) : null,
      wind: gust * amount,
      inertia,
      enabled: this.options.physics,
    });
    const pom = this.hatPhysics.pompom();
    this.pomX.value = pom[0] - 820;
    this.pomY.value = pom[1] - 220;
    this.ribbon.target = this.options.physics
      ? (gust * 0.013 + inertia * 0.0003) * amount
      : 0;
    this.ribbon.step(dt);
    for (const side of ["left", "right"]) {
      const lag = this.sleeveLags[side];
      lag.target = this.options.physics
        ? clamp(
            -this.armPoses[side].velocity * 0.025 + gust * 0.002,
            -0.05,
            0.05,
          )
        : 0;
      lag.step(dt);
    }
  }
  eventPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return [
      (e.clientX - r.left - this.offset[0]) / this.scale,
      (e.clientY - r.top - this.offset[1]) / this.scale,
    ];
  }
  screenPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  setHover(zone) {
    if (this.hovered === zone) return;
    this.hovered = zone;
    this.canvas.style.cursor =
      zone === "pompom" ? "grab" : zone ? "pointer" : "default";
    this.emit("hover", { zone });
  }
  pointerMove(e) {
    const p = this.eventPoint(e);
    this.pointer = { x: p[0], y: p[1], inside: true };
    if (this.drag && this.drag.id === e.pointerId) {
      this.drag.x = p[0];
      this.drag.y = p[1];
      this.drag.moved ||=
        Math.hypot(p[0] - this.drag.start[0], p[1] - this.drag.start[1]) > 5;
      this.canvas.style.cursor = "grabbing";
    } else this.setHover(this.hitTest(...this.screenPoint(e)));
  }
  pointerDown(e) {
    if (e.button !== 0 || this.drag) return;
    const zone = this.hitTest(...this.screenPoint(e));
    this.pressed = {
      zone,
      part: this.hitPart,
      id: e.pointerId,
      start: this.screenPoint(e),
    };
    if (zone === "pompom") {
      if (this.paused) this.setPaused(false);
      const p = this.eventPoint(e);
      this.drag = { id: e.pointerId, start: p, x: p[0], y: p[1], moved: false };
      this.canvas.setPointerCapture(e.pointerId);
      this.setEmotion("surprised", 2);
    }
  }
  pointerUp(e) {
    if (this.drag?.id === e.pointerId) {
      const moved = this.drag.moved;
      this.drag = null;
      if (this.canvas.hasPointerCapture(e.pointerId))
        this.canvas.releasePointerCapture(e.pointerId);
      if (moved) {
        this.setEmotion("shy", 2);
        this.emit("reaction", {
          zone: "pompom",
          message: "Помпон отпущен · возврат с затуханием",
        });
      } else this.react("pompom");
      this.pressed = null;
      this.setHover(null);
      return;
    }
    const p = this.pressed;
    this.pressed = null;
    if (
      p?.id === e.pointerId &&
      p.zone &&
      p.zone === this.hitTest(...this.screenPoint(e)) &&
      Math.hypot(...this.screenPoint(e).map((n, i) => n - p.start[i])) < 15
    )
      this.react(p.zone, p.part);
  }
  cancelDrag(e) {
    if (this.drag?.id === e.pointerId) {
      this.drag = null;
      this.pomX.target = this.pomY.target = 0;
      this.setHover(null);
    }
    this.pressed = null;
  }
  reset(immediate = false) {
    if (!immediate) {
      this.drag = null;
      this.manualPose = false;
      this.poseTarget = 0;
      this.wave.target = 0;
      this.waveGesture.target = 0;
      this.waveUntil = this.talkUntil = this.expressionUntil = 0;
      this.talking = false;
      this.talkEnvelope.target = 0;
      this.setEmotion("neutral");
      this.hat.target =
        this.pomX.target =
        this.pomY.target =
        this.recoil.target =
          0;
      if (this.paused) this.setPaused(false);
      return;
    }
    this.drag = null;
    this.hatPhysics.reset();
    this.ribbon.reset();
    for (const spring of Object.values(this.sleeveLags)) spring.reset();
    for (const chain of Object.values(this.hairChains)) chain.reset();
    for (const spring of [
      ...Object.values(this.armPoses),
      ...Object.values(this.armGestures),
    ])
      spring.reset();
    this.blinkTime = -1;
    this.forcedBlink = false;
    this.manualPose = false;
    this.pose = this.poseTarget = 0;
    this.waveUntil = this.talkUntil = this.expressionUntil = 0;
    this.talking = false;
    for (const spring of [
      this.head,
      this.wave,
      this.waveGesture,
      this.breathingSpring,
      ...Object.values(this.legAngles),
      this.hat,
      this.pomX,
      this.pomY,
      this.recoil,
      this.talkEnvelope,
      ...this.hairLeft,
      ...this.hairRight,
    ])
      spring.reset();
    this.mouthOpening.reset(1);
    this.mouthWidth.reset(1);
    this.mouthRound.reset();
    this.setEmotion("neutral", Infinity, true);
    this.update(0);
    this.render();
  }
  getState() {
    return {
      time: this.time,
      emotion: this.emotion,
      emotionWeights: this.getEmotionWeights(),
      pose: this.pose,
      waveSide: this.waveSide,
      talking: this.talking,
      paused: this.paused,
      options: { ...this.options },
      dragging: Boolean(this.drag),
      layers: Object.keys(this.sprites).length,
      inspection: this.inspection || null,
      hatStrain: this.hatPhysics.strain(),
    };
  }
  /** Renders a canonical pose without idle drift. Restores all live state afterwards. */
  snapshot(pose = 0) {
    const fields = [
      "time",
      "pose",
      "poseTarget",
      "manualPose",
      "emotion",
      "talking",
      "blinkTime",
      "breath",
      "waveUntil",
      "inspection",
    ];
    const saved = Object.fromEntries(fields.map((k) => [k, this[k]])),
      options = { ...this.options };
    const hatState = this.hatPhysics.snapshot();
    const springs = [
      this.head,
      this.wave,
      this.waveGesture,
      this.breathingSpring,
      ...Object.values(this.legAngles),
      this.hat,
      this.pomX,
      this.pomY,
      this.recoil,
      this.talkEnvelope,
      this.mouthOpening,
      this.mouthWidth,
      this.mouthRound,
      this.ribbon,
      ...Object.values(this.sleeveLags),
      ...Object.values(this.expressions),
      ...this.hairLeft,
      ...this.hairRight,
    ];
    for (const chain of Object.values(this.hairChains))
      springs.push(...chain.springs().filter((s) => !springs.includes(s)));
    for (const spring of [
      ...Object.values(this.armPoses),
      ...Object.values(this.armGestures),
    ])
      if (!springs.includes(spring)) springs.push(spring);
    const values = springs.map((s) => [s.value, s.velocity, s.target]);
    try {
      springs.forEach((s) => s.reset());
      this.hatPhysics.reset();
      this.time = 0;
      this.pose = pose;
      this.poseTarget = pose;
      this.manualPose = true;
      this.emotion = "neutral";
      this.expressions.neutral.reset(1);
      this.mouthOpening.reset(1);
      this.mouthWidth.reset(1);
      this.mouthRound.reset();
      this.talking = false;
      this.blinkTime = -1;
      this.breath = 0;
      this.waveUntil = 0;
      this.inspection = null;
      this.options.legs = false;
      this.options.tracking = false;
      this.options.blinking = false;
      this.options.breathing = false;
      this.options.physics = false;
      this.render();
      return this.canvas.toDataURL("image/png");
    } finally {
      Object.assign(this, saved);
      this.hatPhysics.restore(hatState);
      this.options = options;
      springs.forEach((s, i) => {
        [s.value, s.velocity, s.target] = values[i];
      });
      this.render();
    }
  }
  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    for (const [target, type, handler] of this.listeners)
      target.removeEventListener(type, handler);
    this.listeners = [];
    this.renderer.dispose();
  }
}
