import { chromium } from 'playwright';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const pngPath = join(root, 'reaper_photo', 'reaper_icon.png');
const smallPngPath = join(root, 'reaper_photo', 'reaper_icon_small.png');
const icoPath = join(root, 'reaper_photo', 'reaper_icon.ico');

try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  const pngBuffer = await readFile(pngPath);
  const base64Png = pngBuffer.toString('base64');
  
  // Resize to 128x128 and keep the smooth alpha channel for perfect anti-aliased rendering
  const resizedBase64 = await page.evaluate(async (base64) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, 128, 128);
        
        const imgData = ctx.getImageData(0, 0, 128, 128);
        const data = imgData.data;
        for (let i = 0; i < data.length; i += 4) {
          // Preserve the original alpha value, but make color black
          data[i] = 0;     // R
          data[i + 1] = 0; // G
          data[i + 2] = 0; // B
        }
        ctx.putImageData(imgData, 0, 0);
        resolve(canvas.toDataURL('image/png').split(',')[1]);
      };
      img.src = 'data:image/png;base64,' + base64;
    });
  }, base64Png);
  
  await browser.close();
  
  const resizedPngData = Buffer.from(resizedBase64, 'base64');
  
  // Write small PNG
  await writeFile(smallPngPath, resizedPngData);
  console.log('Successfully created high-fidelity 128x128 reaper_icon_small.png');
  
  // Pack into ICO
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);       // Reserved
  header.writeUInt16LE(1, 2);       // Type (1 = ICO)
  header.writeUInt16LE(1, 4);       // Count (1 image)
  
  header.writeUInt8(128, 6);         // Width (128)
  header.writeUInt8(128, 7);         // Height (128)
  header.writeUInt8(0, 8);          // Color count (0)
  header.writeUInt8(0, 9);          // Reserved (0)
  header.writeUInt16LE(1, 10);      // Color planes (1)
  header.writeUInt16LE(32, 12);     // Bits per pixel (32)
  header.writeUInt32LE(resizedPngData.length, 14); // Image size
  header.writeUInt32LE(22, 18);     // Offset of image data
  
  const icoData = Buffer.concat([header, resizedPngData]);
  await writeFile(icoPath, icoData);
  console.log('Successfully created resized 128x128 reaper_icon.ico');
} catch (e) {
  console.error('Error:', e);
}
