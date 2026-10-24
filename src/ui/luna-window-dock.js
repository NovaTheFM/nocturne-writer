const surfaces = [
  ['#form-overlay.active > .form-modal', '#form-overlay'],
  ['#settings-overlay.active > .settings-modal', '#settings-overlay'],
  ['#floating-notes-modal.active > .floating-notes-modal-panel', '#floating-notes-modal'],
  ['#command-palette-overlay.active > .command-palette-panel', '#command-palette-overlay'],
  ['#kb-modal.active', '#kb-modal'],
  ['#entity-hover-card.active', '#entity-hover-card'],
];
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));

export class LunaWindowDock {
  constructor(tutorial) { this.tutorial = tutorial; this.windows = new Map(); }

  sync(enabled, viewport) {
    this.enabled = enabled;
    document.body.classList.toggle('luna-dock-surfaces', enabled);
    if (!enabled) { this.reset(); return false; }
    const width = Math.round(Math.min(628, viewport.width * .44));
    const margin = Math.round(Math.max(24, Math.min(64, viewport.width * .04)));
    const left = viewport.left + margin + width + 28;
    document.body.style.setProperty('--luna-window-left', `${left}px`);
    document.body.style.setProperty('--luna-window-width', `${viewport.left + viewport.width - left - 32}px`);
    this.geometry = { left: viewport.left + margin, width, mascot: width < 500 ? 208 : 236 };
    const current = new Set();
    for (const [selector, hostSelector] of surfaces) {
      const panel = document.querySelector(selector);
      if (!panel || panel.classList.contains('luna-preview-preparing')) continue;
      current.add(panel);
      let state = this.windows.get(panel);
      if (!state) {
        state = { host: document.querySelector(hostSelector), started: performance.now(), phase: 'opening' };
        this.windows.set(panel, state);
        panel.dataset.lunaDock = 'opening';
      }
      // Native settings updates patch the same panel, including its class and data attributes.
      if (state.phase !== 'opening') panel.classList.add('luna-docked-window');
      if (panel.dataset.lunaDock !== state.phase) panel.dataset.lunaDock = state.phase;
      const settingsWaiting = panel.matches('.settings-modal') && this.tutorial.canShowSettingsAside() && !this.tutorial.settingsAside;
      if (state.phase === 'opening' && !settingsWaiting && performance.now() - state.started >= 360) this.move(panel, state);
    }
    for (const [panel, state] of this.windows) {
      if (current.has(panel)) continue;
      // Keep the resting position throughout the native closing fade.
      if (!panel.isConnected || Number(getComputedStyle(state.host).opacity) < .01) this.clear(panel);
    }
    return current.size > 0 || !!document.querySelector('#notes-panel.open');
  }

  move(panel, state = this.windows.get(panel)) {
    if (!state || state.phase !== 'opening') return;
    state.phase = 'moving'; panel.dataset.lunaDock = 'moving';
    const before = panel.getBoundingClientRect();
    panel.classList.add('luna-docked-window');
    const after = panel.getBoundingClientRect();
    // A separate translate channel leaves the window's native appearance transform intact.
    state.motion = this.tutorial.app.runMotion(panel, [{ translate: `${before.left - after.left}px 0` }, { translate: '0px 0' }], {
      channel: 'tutorial-window', duration: 680, easing: 'cubic-bezier(.45, 0, .2, 1)', startFromCurrent: false,
    });
    state.motion.finished.then(() => {
      if (this.windows.get(panel) !== state) return;
      state.phase = 'settled'; panel.dataset.lunaDock = 'settled';
    });
  }

  async moveSettings() {
    const panel = document.querySelector('#settings-overlay.active > .settings-modal');
    if (!panel) return;
    this.move(panel);
    await this.settled();
  }

  async settled() {
    while (this.enabled && this.tutorial.active && !this.tutorial.finishing && [...this.windows.values()].some(state => state.phase !== 'settled')) await frame();
  }

  clear(panel) { this.windows.get(panel)?.motion?.animation?.cancel(); panel.classList.remove('luna-docked-window'); delete panel.dataset.lunaDock; this.windows.delete(panel); }

  reset() {
    for (const panel of this.windows.keys()) this.clear(panel);
    document.body.classList.remove('luna-dock-surfaces');
    document.body.style.removeProperty('--luna-window-left');
    document.body.style.removeProperty('--luna-window-width');
  }

  dispose() {
    this.enabled = false;
    const panels = [...this.windows.keys()].filter(panel => panel.isConnected).map(panel => ({ panel, rect: panel.getBoundingClientRect() }));
    const hosts = new Map([...this.windows.values()].map(state => [state.host, state.host.style.transitionProperty]));
    for (const host of hosts.keys()) host.style.transitionProperty = 'opacity, visibility, transform';
    this.reset();
    const motions = [];
    for (const { panel, rect } of panels) {
      const after = panel.getBoundingClientRect();
      motions.push(this.tutorial.app.runMotion(panel, [{ translate: `${rect.left - after.left}px ${rect.top - after.top}px` }, { translate: '0px 0px' }], { channel: 'tutorial-window', duration: 500, easing: 'cubic-bezier(.45, 0, .2, 1)', startFromCurrent: false }).finished);
    }
    Promise.all(motions).then(() => { for (const [host, transition] of hosts) host.style.transitionProperty = transition; });
  }
}
