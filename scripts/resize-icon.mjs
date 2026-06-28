import { chromium } from 'playwright';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const pngPath = join(root, 'reaper_photo', 'reaper_icon.png');
const icoPath = join(root, 'reaper_photo', 'reaper_icon.ico');

try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  const pngBuffer = await readFile(pngPath);
  const base64Png = pngBuffer.toString('base64');
  
  const resizedBase64 = await page.evaluate(async (base64) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, 32, 32);
        resolve(canvas.toDataURL('image/png').split(',')[1]);
      };
      img.src = 'data:image/png;base64,' + base64;
    });
  }, base64Png);
  
  await browser.close();
  
  const resizedPngData = Buffer.from(resizedBase64, 'base64');
  
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);       // Reserved
  header.writeUInt16LE(1, 2);       // Type (1 = ICO)
  header.writeUInt16LE(1, 4);       // Count (1 image)
  
  header.writeUInt8(32, 6);         // Width (32)
  header.writeUInt8(32, 7);         // Height (32)
  header.writeUInt8(0, 8);          // Color count (0)
  header.writeUInt8(0, 9);          // Reserved (0)
  header.writeUInt16LE(1, 10);      // Color planes (1)
  header.writeUInt16LE(32, 12);     // Bits per pixel (32)
  header.writeUInt32LE(resizedPngData.length, 14); // Image size
  header.writeUInt32LE(22, 18);     // Offset of image data
  
  const icoData = Buffer.concat([header, resizedPngData]);
  await writeFile(icoPath, icoData);
  console.log('Successfully created resized 32x32 reaper_icon.ico');
} catch (e) {
  console.error('Error:', e);
}
