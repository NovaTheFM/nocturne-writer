import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const pngPath = join(root, 'reaper_photo', 'reaper_icon.png');

try {
  const pngBuffer = await readFile(pngPath);
  const base64Png = pngBuffer.toString('base64');
  const dataUrl = `data:image/png;base64,${base64Png}`;
  
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  
  await page.goto('about:blank');
  
  await page.evaluate(async (imgUrl) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, 512, 512);
        
        const imgData = ctx.getImageData(0, 0, 512, 512);
        const data = imgData.data;
        
        // Print top-left, center, and bottom-right pixel colors
        console.log('Top-Left (0,0):', data[0], data[1], data[2], data[3]);
        console.log('Center (256,256):', data[256*4*512 + 256*4], data[256*4*512 + 256*4 + 1], data[256*4*512 + 256*4 + 2], data[256*4*512 + 256*4 + 3]);
        resolve();
      };
      img.src = imgUrl;
    });
  }, dataUrl);
  
  await browser.close();
} catch (e) {
  console.error('Test error:', e);
}
