import { t } from '../core/i18n.js';
export function updateRangeMotion(app, control, percentage) {
  const field = control.closest('[data-range-field]');
  if (!field) return;
  let rail = field.querySelector('.range-motion-rail');
  if (!rail) {
    rail = document.createElement('span');
    rail.className = 'range-motion-rail'; rail.setAttribute('aria-hidden', 'true');
    rail.innerHTML = '<span class="range-motion-fill"></span><span class="range-motion-thumb"></span>';
    field.append(rail);
  }
  control.classList.add('range-motion-ready');
  field.classList.add('range-motion-field');
  if (!control.hasAttribute('aria-label')) control.setAttribute('aria-label', field.closest('.setting-row')?.querySelector('.setting-info > span')?.textContent || t('Значение'));
  const rect = control.getBoundingClientRect(), bounds = field.getBoundingClientRect();
  rail.style.width = `${rect.width}px`; rail.style.left = `${rect.left - bounds.left}px`;
  const state = field.__rangeMotion ||= { displayed: percentage, target: percentage, frame: null, time: performance.now() };
  state.target = percentage;
  const paint = () => {
    rail.style.setProperty('--range-visual', `${state.displayed}%`);
    rail.style.setProperty('--range-thumb-x', `${Math.max(0, rect.width - 18) * state.displayed / 100}px`);
  };
  state.paint = paint;
  if (app.shouldReduceSurfaceMotion()) {
    cancelAnimationFrame(state.frame); state.frame = null; state.displayed = percentage; paint(); return;
  }
  paint();
  if (state.frame || Math.abs(state.displayed - state.target) < .01) return;
  state.time = performance.now();
  const step = now => {
    state.frame = null;
    if (!field.isConnected) return;
    const delta = Math.min(48, now - state.time); state.time = now;
    state.displayed += (state.target - state.displayed) * (1 - Math.exp(-delta / 42));
    if (Math.abs(state.displayed - state.target) < .03) state.displayed = state.target;
    state.paint();
    if (state.displayed !== state.target) state.frame = requestAnimationFrame(step);
  };
  state.frame = requestAnimationFrame(step);
}
