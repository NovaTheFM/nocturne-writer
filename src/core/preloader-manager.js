/**
 * Nocturne Horizon Preloader Engine
 * Ultra-minimalist Luxury Editorial Interface with Horizon Hairline Physics
 */
export class PreloaderEngine {
  constructor(options = {}) {
    this.container = options.container || null;
    this.targetProgress = 0;
    this.currentProgress = 0;
    this.animFrameId = null;
    this.isExiting = false;
    this.onComplete = options.onComplete || null;
  }

  mount(targetParent = document.body) {
    if (this.container) return;
    this.container = document.createElement('div');
    this.container.id = 'cosmic-preloader';
    this.container.className = 'cosmic-preloader-overlay horizon-mode';
    this.container.innerHTML = `
      <div class="horizon-spotlight"></div>
      <div class="horizon-ambient-ring"></div>
      <div class="horizon-content">
        <div class="horizon-brand-header">
          <div class="horizon-logo-emblem"></div>
          <div class="horizon-title-group">
            <h1 class="horizon-title">NOCTURNE</h1>
            <div class="horizon-subtitle">MANUSCRIPT & LORE ENGINE</div>
          </div>
        </div>
        
        <div class="horizon-progress-container">
          <div class="horizon-hairline-track">
            <div class="horizon-hairline-fill" id="cosmic-progress-fill">
              <div class="horizon-ember-tip"></div>
            </div>
          </div>
          <div class="horizon-meta-row">
            <span class="horizon-status-text" id="cosmic-status-text">Инициализация структуры...</span>
            <span class="horizon-percent" id="cosmic-percent">0%</span>
          </div>
        </div>
      </div>
    `;
    targetParent.appendChild(this.container);

    // Force reflow before adding .active to guarantee silky 650ms entrance fade
    void this.container.offsetWidth;
    requestAnimationFrame(() => {
      if (this.container) this.container.classList.add('active');
    });

    this.startLoop();
  }

  setProgress(targetPct, statusMessage = null) {
    this.targetProgress = Math.min(100, Math.max(0, targetPct));
    if (statusMessage) {
      this.setStatusText(statusMessage);
    }
  }

  setStatusText(msg) {
    const el = this.container?.querySelector('#cosmic-status-text');
    if (!el || el.innerText === msg) return;
    el.style.opacity = '0';
    el.style.transform = 'translateY(3px)';
    setTimeout(() => {
      el.innerText = msg;
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    }, 120);
  }

  startLoop() {
    const fillEl = this.container?.querySelector('#cosmic-progress-fill');
    const percentEl = this.container?.querySelector('#cosmic-percent');

    const loop = () => {
      // Silky smooth lerp computation (0.045) for clean hair-line progress
      const diff = this.targetProgress - this.currentProgress;
      if (Math.abs(diff) > 0.02) {
        this.currentProgress += diff * 0.045;
      } else {
        this.currentProgress = this.targetProgress;
      }

      const displayPct = Math.round(this.currentProgress);
      if (fillEl) fillEl.style.width = `${this.currentProgress.toFixed(1)}%`;
      if (percentEl) percentEl.innerText = `${displayPct}%`;

      if (this.container && (this.container.classList.contains('active') || !this.isExiting)) {
        this.animFrameId = requestAnimationFrame(loop);
      }
    };

    loop();
  }

  destroy() {
    if (this.isExiting) return;
    this.isExiting = true;
    if (this.container) {
      this.container.classList.remove('active');
      this.container.classList.add('exiting');
      setTimeout(() => {
        if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
        this.container?.remove();
        this.container = null;
        if (this.onComplete) this.onComplete();
      }, 700);
    }
  }
}
