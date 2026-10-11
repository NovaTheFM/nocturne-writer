import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FRAME_CAMERA_ARGS = ['--enable-begin-frame-control', '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout', '--disable-threaded-animation', '--disable-threaded-scrolling'];

export class FrameCamera {
  constructor(page, directory) {
    this.page = page;
    this.directory = directory;
    this.fps = 60;
    this.time = 0;
  }

  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.pumping = true;
    this.pump = (async () => {
      while (this.pumping) {
        await this.cdp.send('HeadlessExperimental.beginFrame').catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 16));
      }
    })();
  }

  async pause() {
    this.pumping = false;
    await this.pump;
    const result = await this.cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
    this.base = result.virtualTimeTicksBase;
  }

  async advance(milliseconds = 1000 / this.fps, screenshot = false, inputFrame = false) {
    const expired = new Promise(resolve => this.cdp.once('Emulation.virtualTimeBudgetExpired', resolve));
    await this.cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: milliseconds, maxVirtualTimeTaskStarvationCount: 10000 });
    this.time += milliseconds;
    const draw = () => this.cdp.send('HeadlessExperimental.beginFrame', {
      frameTimeTicks: this.base + this.time, interval: milliseconds,
      ...(screenshot ? { screenshot: { format: 'png' } } : {}),
    });
    let result;
    if (inputFrame) result = await draw();
    await expired;
    if (!inputFrame) result = await draw();
    return screenshot ? Buffer.from(result.screenshotData, 'base64') : null;
  }

  async settle(milliseconds = 600) {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) await this.advance(Math.min(50, milliseconds - elapsed));
  }

  async screenshot(name) {
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, `${name}.png`), await this.advance(1000 / this.fps, true));
  }

  async click(selector) {
    const rect = await this.page.locator(selector).first().boundingBox();
    if (!rect) throw new Error(`Capture action has no visible target: ${selector}`);
    await this.page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  }

  async input(action) {
    let complete = false;
    const pending = action().finally(() => { complete = true; });
    while (!complete) await this.advance();
    await pending;
  }

  async record(name, { frames = 120, events = [], inspect = null, video = true, clip = null, beforeFrame = null } = {}) {
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, `${name}.webm`);
    let encoder, finished, stderr = '';
    if (video) {
      const crop = clip ? ['-vf', `crop=${clip.width}:${clip.height}:${clip.x}:${clip.y}`] : [];
      encoder = spawn(process.env.NOCTURNE_FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(this.fps), '-vcodec', 'png', '-i', 'pipe:0', ...crop, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '18', '-deadline', 'realtime', '-cpu-used', '4', '-row-mt', '1', '-pix_fmt', 'yuv420p', target], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      encoder.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
      finished = new Promise((resolve, reject) => {
        encoder.on('error', reject);
        encoder.on('close', code => code === 0 ? resolve() : reject(new Error(`Frame encoder: ${code}\n${stderr}`)));
      });
    }
    const hashes = new Set(), observations = [];
    try {
      for (let frame = 0; frame < frames; frame++) {
        for (const event of events) if (event.frame === frame) await event.action();
        const input = beforeFrame?.(frame);
        const pixels = await this.advance(1000 / this.fps, video, !!beforeFrame);
        await input;
        if (video) {
          hashes.add(createHash('sha256').update(pixels).digest('hex'));
          if (!encoder.stdin.write(pixels)) await once(encoder.stdin, 'drain');
        }
        if (inspect) observations.push({ frame, ...await this.page.evaluate(inspect) });
      }
      if (video) { encoder.stdin.end(); await finished; }
    } catch (error) {
      encoder?.kill(); await finished?.catch(() => {}); throw error;
    }
    const result = { name, fps: this.fps, frames, seconds: frames / this.fps, ...(video ? { video: `${name}.webm`, distinctFrames: hashes.size } : {}), clip, observations };
    await writeFile(join(this.directory, `${name}.json`), JSON.stringify(result, null, 2));
    return result;
  }

  async close() {
    this.pumping = false;
    await this.pump;
    await this.cdp.detach().catch(() => {});
  }
}
