import { chromium } from 'playwright';
import { FRAME_CAMERA_ARGS, FrameCamera } from '../scripts/qa/frame-camera.mjs';
import { readFile } from 'node:fs/promises';

export async function captureNativeSelection(page, camera, name, video = true) {
  await page.evaluate(() => {
    const a = window.nocturneApp, editor = a.nocturneEditor.get('primary');
    editor.commands.setTextSelection(18); editor.view.focus(); a.renderNocturneSelectionLayer();
  });
  await camera.settle();
  const points = await page.evaluate(() => {
    const view = window.nocturneApp.nocturneEditor.get('primary').view;
    return [18, 42, 24].map(position => { const r = view.coordsAtPos(position); return { x: r.left + .2, y: (r.top + r.bottom) / 2 }; });
  });
  const dispatch = (type, point, buttons) => camera.cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, buttons, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 }).catch(() => {});
  dispatch('mouseMoved', points[0], 0);
  await camera.advance(1000 / 60, false, true);
  return camera.record(name, {
    frames: 210, video,
    beforeFrame: frame => {
      if (frame === 18) dispatch('mousePressed', points[0], 1);
      if (frame >= 19 && frame < 90) {
        const progress = (frame - 19) / 70;
        dispatch('mouseMoved', { x: points[0].x + (points[1].x - points[0].x) * progress, y: points[0].y + (points[1].y - points[0].y) * progress }, 1);
      }
      if (frame >= 90 && frame < 150) {
        const progress = (frame - 90) / 59;
        dispatch('mouseMoved', { x: points[1].x + (points[2].x - points[1].x) * progress, y: points[1].y + (points[2].y - points[1].y) * progress }, 1);
      }
      if (frame === 150) dispatch('mouseReleased', points[2], 0);
    },
    inspect: () => {
      const editor = window.nocturneApp.nocturneEditor.get('primary'), rect = document.querySelector('.nocturne-selection-rect');
      return { width: rect?.getBoundingClientRect().width || 0, target: parseFloat(rect?.style.width || '0'), native: getSelection().toString(), text: editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to), from: editor.state.selection.from, to: editor.state.selection.to, dragging: document.body.classList.contains('is-selecting-text') };
    },
  });
}

if (process.argv.includes('--capture')) {
  const browser = await chromium.launch({ args: FRAME_CAMERA_ARGS });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    if (process.argv.includes('--before')) {
      for (const [url, file] of [['**/src/main.js*', 'main.js'], ['**/src/css/ui.css*', 'ui.css'], ['**/src/css/polish.css*', 'polish.css']]) {
        await page.route(url, route => readFile(`release/motion-corrections/baseline-source/${file}`).then(body => route.fulfill({ status: 200, contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body })));
      }
    }
    const camera = new FrameCamera(page, process.argv[3]);
    await camera.start(); await page.goto('http://127.0.0.1:5173'); console.log('loaded');
    await page.waitForFunction(() => window.nocturneApp?.backups && document.querySelector('.app-shell.ready'), null, { polling: 50 }); console.log('ready');
    await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Ночной город', '');
      a.nocturneEditor.get('primary').commands.setContent('<h2>Первая встреча</h2><p>Анна пришла в тихий город. Вечерний свет отражался в окнах. На площади её ждали друзья, с которыми она собиралась отправиться к реке.</p><p>Она остановилась у старого моста и перечитала письмо. Эта встреча должна была изменить всё.</p>');
    });
    console.log('seeded'); await new Promise(resolve => setTimeout(resolve, 1200)); await camera.pause(); console.log('paused');
    const result = await captureNativeSelection(page, camera, 'desktop-dark-selection-native');
    console.log(JSON.stringify({ frames: result.frames, distinct: result.distinctFrames, selected: result.observations.at(-1).native, dragging: result.observations.filter(sample => sample.dragging).length }));
    await camera.close();
  } finally { await browser.close(); }
}
