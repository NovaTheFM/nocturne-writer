import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const pngPath = join(root, 'reaper_photo', 'reaper_icon.png');
const icoPath = join(root, 'reaper_photo', 'reaper_icon.ico');

try {
  const pngData = await readFile(pngPath);
  
  const header = Buffer.alloc(22);
  
  header.writeUInt16LE(0, 0);       // Reserved
  header.writeUInt16LE(1, 2);       // Type (1 = ICO)
  header.writeUInt16LE(1, 4);       // Count (1 image)
  
  header.writeUInt8(0, 6);          // Width (0 for 256 or larger)
  header.writeUInt8(0, 7);          // Height (0 for 256 or larger)
  header.writeUInt8(0, 8);          // Color count (0)
  header.writeUInt8(0, 9);          // Reserved (0)
  header.writeUInt16LE(1, 10);      // Color planes (1)
  header.writeUInt16LE(32, 12);     // Bits per pixel (32)
  header.writeUInt32LE(pngData.length, 14); // Image size
  header.writeUInt32LE(22, 18);     // Offset of image data
  
  const icoData = Buffer.concat([header, pngData]);
  await writeFile(icoPath, icoData);
  console.log('Successfully created reaper_icon.ico');
} catch (e) {
  console.error('Error creating ICO file:', e);
}
