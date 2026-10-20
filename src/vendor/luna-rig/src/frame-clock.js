/** Display cadence is independent of monitor refresh and simulation speed. */
export class FrameClock {
  constructor(maxFPS = 30) {
    this.setRate(maxFPS);
    this.reset();
  }
  setRate(maxFPS) {
    this.interval = 1000 / Math.max(12, Math.min(60, maxFPS));
  }
  reset() {
    this.last = null;
    this.next = 0;
  }
  take(now) {
    if (this.last !== null && now + 0.5 < this.next) return null;
    const dt = this.last === null ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.next = Math.max(this.next + this.interval, now + this.interval * 0.8);
    return dt;
  }
}
