import { chromium } from 'playwright';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const pngPath = join(root, 'reaper_photo', 'reaper_icon.png');
const svgPath = join(root, 'reaper_photo', 'reaper_icon.svg');

try {
  const pngBuffer = await readFile(pngPath);
  const base64Png = pngBuffer.toString('base64');
  const dataUrl = `data:image/png;base64,${base64Png}`;
  
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  await page.goto('about:blank');
  await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/imagetracerjs@1.2.6/imagetracer_v1.2.6.js' });
  
  const svgString = await page.evaluate(async (imgUrl) => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        // Downscale to 64x64 to merge fine details into a solid, bold shape
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, 64, 64);
        
        const imgData = ctx.getImageData(0, 0, 64, 64);
        const data = imgData.data;
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3];
          if (alpha > 50) {
            data[i] = 0;       // R
            data[i + 1] = 0;   // G
            data[i + 2] = 0;   // B
            data[i + 3] = 255; // Solid black
          } else {
            data[i] = 255;     // R
            data[i + 1] = 255; // G
            data[i + 2] = 255; // B
            data[i + 3] = 255; // Solid white
          }
        }
        ctx.putImageData(imgData, 0, 0);
        
        const processedUrl = canvas.toDataURL('image/png');
        
        ImageTracer.imageToSVG(
          processedUrl,
          (svgstr) => {
            resolve(svgstr);
          },
          {
            ltres: 0.1,
            qtres: 0.1,
            colorsampling: 0,
            numberofcolors: 2,
            pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }],
            scale: 1,
            roundcoords: 1,
            viewbox: true
          }
        );
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = imgUrl;
    });
  }, dataUrl);
  
  await browser.close();
  
  let cleanedSvg = svgString;
  cleanedSvg = cleanedSvg.replace(/<path fill="rgb\(255,255,255\)"[^>]*\/>/g, '');
  cleanedSvg = cleanedSvg.replace(/fill="rgb\(0,0,0\)"/g, 'fill="currentColor"');
  cleanedSvg = cleanedSvg.replace(/stroke="rgb\(0,0,0\)"/g, 'stroke="currentColor"');
  
  await writeFile(svgPath, cleanedSvg);
  console.log('Successfully generated clean vector SVG:', svgPath);
} catch (e) {
  console.error('Tracing error:', e);
}
