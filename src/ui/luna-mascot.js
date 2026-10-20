import { t } from '../core/i18n.js';

let loading = Promise.resolve();

export class LunaMascot {
  constructor(tour) {
    this.tour = tour;
    this.host = tour.root.querySelector('[data-luna-mascot]');
    this.canvas = this.host.querySelector('canvas');
    this.retry = this.host.querySelector('button');
    this.destroyed = false;
    this.speech = 0;
    this.retry.onclick = () => this.enqueue();
    this.onKey = event => {
      if (!['Enter', ' '].includes(event.key) || !this.rig) return;
      event.preventDefault(); event.stopPropagation();
      this.rig.react(event.key === 'Enter' ? 'hand' : 'hat');
    };
    this.canvas.onkeydown = this.onKey;
    this.onPageHide = () => this.destroy();
    window.addEventListener('pagehide', this.onPageHide);
    this.enqueue();
  }

  enqueue() {
    if (this.failed) {
      const canvas = this.canvas.cloneNode(false);
      this.canvas.replaceWith(canvas); this.canvas = canvas;
      this.canvas.onkeydown = this.onKey;
      this.failed = false;
    }
    this.retry.hidden = true;
    this.host.dataset.lunaRigReady = 'false';
    this.host.setAttribute('aria-busy', 'true');
    this.ready = loading.catch(() => {}).then(() => this.load());
    loading = this.ready;
    return this.ready;
  }

  async load() {
    if (this.destroyed) return;
    let rig;
    try {
      const { LunaStateRig } = await import('../vendor/luna-rig/src/luna-state-rig.js');
      if (this.destroyed) return;
      rig = new LunaStateRig(this.canvas, { autoStart: false });
      await rig.load();
      if (this.destroyed) { rig.destroy(); return; }
      this.rig = rig;
      rig.addEventListener('reaction', () => this.restrictMotion());
      rig.addEventListener('error', event => this.fail(event.detail.message));
      await this.syncPose(true);
      if (this.destroyed || rig.destroyed) return;
      rig.resize();
      this.restrictMotion();
      rig.start();
      this.host.dataset.lunaRigReady = 'true';
      this.host.setAttribute('aria-busy', 'false');
    } catch (error) {
      rig?.destroy();
      if (!this.destroyed) this.fail(error.message);
    }
  }

  fail(message) {
    console.warn('Luna rig:', message);
    this.rig?.destroy(); this.rig = null;
    this.failed = true;
    this.host.dataset.lunaRigReady = 'false';
    this.host.setAttribute('aria-busy', 'false');
    this.retry.hidden = false;
    this.retry.textContent = t('Повторить загрузку Луны');
  }

  syncPose(immediate = this.tour.app.shouldReduceSurfaceMotion()) {
    const greeting = this.tour.step === 'welcome';
    if (!this.rig) return;
    return this.rig.setPose(greeting ? 1 : 0, immediate);
  }

  restrictMotion() {
    if (!this.rig || !this.tour.app.shouldReduceSurfaceMotion()) return;
    this.rig.setPose(this.tour.step === 'welcome' ? 1 : 0, true);
    this.rig.setEmotion(this.rig.emotion, Infinity, true);
    this.rig.setPaused(true);
  }

  syncMotion() {
    const reduced = this.tour.app.shouldReduceSurfaceMotion();
    if (!this.rig || reduced === this.reduced) return;
    this.reduced = reduced;
    if (reduced) this.restrictMotion();
    else this.rig.setPaused(false);
  }

  speak(duration) {
    const speech = ++this.speech;
    this.canvas.setAttribute('aria-label', t('Луна'));
    this.syncPose();
    this.ready.then(() => {
      if (this.destroyed || speech !== this.speech || !this.rig) return;
      this.syncPose();
      if (!this.tour.app.shouldReduceSurfaceMotion()) this.rig.startTalking(duration / 1000);
      else this.restrictMotion();
    });
  }

  stopSpeaking() {
    this.speech++;
    if (this.rig?.talking) { this.rig.stopTalking(); this.restrictMotion(); }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.speech++;
    this.rig?.destroy(); this.rig = null;
    window.removeEventListener('pagehide', this.onPageHide);
    this.canvas.onkeydown = null; this.retry.onclick = null;
  }
}
