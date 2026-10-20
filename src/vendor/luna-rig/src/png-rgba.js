/** Decode authored RGBA8 PNG bytes without browser premultiply/unpremultiply
 * rounding. Native premultiplied materials must reach WebGL byte-for-byte.
 */
export async function rgbaPng(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer()),
    view = new DataView(bytes.buffer);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a)
    throw new Error("Expected a PNG material");
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0)
    throw new Error("Native materials require non-interlaced RGBA8 PNG");
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset),
      type = view.getUint32(offset + 4);
    if (type === 0x49444154)
      chunks.push(bytes.slice(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const compressed = new Blob(chunks)
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const rows = new Uint8Array(await new Response(compressed).arrayBuffer()),
    stride = width * 4,
    pixels = new Uint8Array(stride * height);
  if (rows.length !== (stride + 1) * height)
    throw new Error("Invalid native PNG scanline size");
  for (let y = 0; y < height; y++) {
    const mode = rows[y * (stride + 1)],
      source = y * (stride + 1) + 1,
      target = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[target + x - 4] : 0,
        up = y ? pixels[target + x - stride] : 0,
        corner = y && x >= 4 ? pixels[target + x - stride - 4] : 0;
      let prediction = 0;
      if (mode === 1) prediction = left;
      else if (mode === 2) prediction = up;
      else if (mode === 3) prediction = (left + up) >> 1;
      else if (mode === 4) {
        const p = left + up - corner,
          a = Math.abs(p - left),
          b = Math.abs(p - up),
          c = Math.abs(p - corner);
        prediction = a <= b && a <= c ? left : b <= c ? up : corner;
      } else if (mode !== 0) throw new Error("Invalid native PNG filter");
      pixels[target + x] = (rows[source + x] + prediction) & 255;
    }
  }
  return { width, height, pixels };
}
