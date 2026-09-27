import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

function simplePdf(text) {
  const stream = `BT /F1 14 Tf 72 720 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Array.from(Buffer.from(pdf));
}
const port = 5286, server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const page = await browser.newPage(), external = [];
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname === 'localhost') return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.goto(`http://localhost:${port}`); await page.waitForFunction(() => window.nocturneApp?.databaseSync);
  await page.evaluate(() => document.fonts.ready);
  const text = await page.evaluate(bytes => window.nocturneApp.extractTextFromPdf(new File([new Uint8Array(bytes)], 'offline.pdf', { type: 'application/pdf' })), simplePdf('Nocturne offline PDF import works'));
  assert.match(text, /Nocturne offline PDF import works/); assert.deepEqual(external, []);
  console.log('Fonts, application boot and PDF worker/import succeed with all external network requests blocked.');
} finally { await browser.close(); server.kill(); }
