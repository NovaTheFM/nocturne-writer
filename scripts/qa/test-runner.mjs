import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PROJECT_CHECKS, EXTRA_CHECKS, ARTIFACT_CHECKS, AREA_LABELS } from './checks.mjs';
import { availablePort, runCheck, archiveEvidence, sourceFingerprint } from './runner.mjs';
import { reportStatus, writeReports } from './report.mjs';

const fixtures = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/tester-contract');
await mkdir(fixtures, { recursive: true });
const temporary = () => mkdtemp(join(fixtures, 'fixture-'));

test('Failures and missing required checks cannot produce a passing report', () => {
  const passed = { id: 'source', status: 'PASS' };
  assert.equal(reportStatus([passed]), 'PASS');
  for (const status of ['FAIL', 'TIMEOUT', 'CANCELLED', 'FLAKY']) {
    assert.equal(reportStatus([passed, { status }]), 'FAIL');
  }
  for (const status of ['PENDING', 'RUNNING', 'unknown', undefined]) {
    assert.equal(reportStatus([passed, { status }]), 'INCOMPLETE');
  }
  assert.equal(reportStatus([]), 'INCOMPLETE');
  const native = { id: 'native-android', status: 'SKIP' };
  assert.equal(reportStatus([passed, native]), 'PASS_WITH_GAPS');
  assert.equal(reportStatus([passed, native], { requireNative: true }), 'INCOMPLETE');
  assert.equal(reportStatus([passed, { status: 'SKIP', artifact: 'old.apk' }], { requireArtifacts: true }), 'INCOMPLETE');
});

test('Every registered suite has a unique ID, valid area, command and timeout', () => {
  const catalog = [...PROJECT_CHECKS, ...EXTRA_CHECKS, ...ARTIFACT_CHECKS];
  assert.equal(new Set(catalog.map(check => check.id)).size, catalog.length);
  for (const check of catalog) {
    assert.ok(check.args.length && check.executable && check.timeout > 0, check.id);
    assert.ok(check.platforms.length && Array.isArray(check.modes) && check.modes.every(mode => ['smoke', 'full'].includes(mode)), check.id);
    assert.ok(check.areas.every(area => AREA_LABELS[area]), check.id);
    assert.ok(check.ports.every(port => Number.isInteger(port) && port > 0 && port < 65536), check.id);
  }
});

test('Runner records real stdout/stderr, a failure code and a missing executable', async () => {
  const directory = await temporary();
  const result = await runCheck({ id: 'failure', args: ['-e', "console.log('fixture output');console.error('fixture error');process.exitCode=7"], timeout: 5000 }, {
    root: process.cwd(), directory, heartbeat: false,
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.exitCode, 7);
  const log = await readFile(result.logPath, 'utf8');
  assert.match(log, /fixture output/);
  assert.match(log, /fixture error/);
  const missing = await runCheck({ id: 'missing', executable: join(directory, 'does-not-exist'), args: [], timeout: 5000 }, {
    root: process.cwd(), directory: join(directory, 'missing'), heartbeat: false,
  });
  assert.equal(missing.status, 'FAIL');
  assert.match(missing.error, /ENOENT/);
});

test('Timeout terminates its owned process and produces TIMEOUT evidence', async () => {
  let owned;
  const result = await runCheck({ id: 'timeout', args: ['-e', 'setInterval(()=>{},1000)'], timeout: 700 }, {
    root: process.cwd(), directory: await temporary(), heartbeat: false, onChild: child => { if (child) owned = child; },
  });
  assert.equal(result.status, 'TIMEOUT');
  assert.match(result.error, /700 ms/);
  let alive = true;
  for (let attempt = 0; attempt < 30 && alive; attempt++) {
    try { process.kill(owned.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(alive, false, 'The timed-out process must not remain alive');
});

test('Occupied port is rejected while the existing listener stays alive', async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(availablePort(server.address().port), error => error.code === 'EADDRINUSE');
    assert.equal(server.listening, true);
    assert.ok(await availablePort());
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('HTML and JUnit escape hostile diagnostics and keep pending checks visibly unverified', async () => {
  const directory = await temporary();
  const report = {
    status: 'FAIL', startedAt: new Date().toISOString(), options: { platform: 'all', mode: 'full', seed: 1 },
    results: [{ id: 'unsafe <&"', status: 'FAIL', error: '<script>alert("unsafe")</script>', tail: '\u001b[31mA & B\u001b[0m\u0000', areas: ['writing'] }, { id: 'not-finished', status: 'PENDING', areas: ['writing'] }],
  };
  await writeReports(directory, report);
  const html = await readFile(join(directory, 'index.html'), 'utf8');
  const xml = await readFile(join(directory, 'junit.xml'), 'utf8');
  assert.ok(!html.includes('<script>alert('));
  assert.match(html, /&lt;script&gt;/);
  assert.match(xml, /failures="1" skipped="1"/);
  assert.match(xml, /<skipped message="PENDING"/);
  assert.match(xml, /A &amp; B/);
  assert.ok(!/[\u0000\u001b]/.test(xml), 'Terminal colors and NUL must not invalidate XML');
  assert.equal(report.coverage.find(area => area.id === 'writing').status, 'FAIL');
});

test('Source fingerprint detects a module change and ignores generated QA logs', async () => {
  const directory = await temporary();
  for (const folder of ['src', 'scripts', 'android/app/src/main/java', 'android/app/src/main/res']) await mkdir(join(directory, folder), { recursive: true });
  for (const file of ['index.html', 'package.json', 'capacitor.config.json', 'android/app/src/main/AndroidManifest.xml']) await writeFile(join(directory, file), '{}');
  await writeFile(join(directory, 'src/editor.js'), 'export const value=1;');
  const before = await sourceFingerprint(directory);
  await mkdir(join(directory, 'release'), { recursive: true });
  await writeFile(join(directory, 'release/output.log'), 'unrelated diagnostics');
  assert.equal(await sourceFingerprint(directory), before);
  await writeFile(join(directory, 'src/editor.js'), 'export const value=2;');
  assert.notEqual(await sourceFingerprint(directory), before);
});

test('Evidence archive excludes profiles, old evidence and its own output directory', async () => {
  const root = await temporary();
  const output = join(root, 'custom-output', 'check');
  await mkdir(output, { recursive: true });
  await mkdir(join(root, 'profile-secret'), { recursive: true });
  await writeFile(join(root, 'profile-secret/data.json'), '{"secret":true}');
  await writeFile(join(root, 'old.json'), '{}');
  await new Promise(resolve => setTimeout(resolve, 150));
  const started = Date.now();
  await writeFile(join(root, 'fresh.json'), '{"result":"fixture"}');
  const copied = await archiveEvidence(root, output, started);
  assert.deepEqual(copied, [join(output, 'artifacts/fresh.json')]);
  assert.match(await readFile(copied[0], 'utf8'), /fixture/);
});

test('Report filters work and expanded long feature names fit narrow screens', async () => {
  const directory=await temporary();
  await writeReports(directory, {
    status:'PASS_WITH_GAPS', options:{platform:'all',mode:'full',seed:1},
    results:[{id:'writing-case',status:'PASS'},{id:'native-case',status:'SKIP',reason:'No device'}],
    features:{methods:[{name:'handleMobileEditorSelectionPointerDown'.repeat(3),file:'src/main.js',line:1,observed:false}]},
  });
  const browser=await chromium.launch({headless:true,...(process.env.NOCTURNE_QA_BROWSER_CHANNEL?{channel:process.env.NOCTURNE_QA_BROWSER_CHANNEL}:{})});
  try {
    const page=await browser.newPage();
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:900});
      await page.goto(pathToFileURL(join(directory,'index.html')).href);
      await page.locator('#search').fill('writing-case');assert.equal(await page.locator('article:visible').count(),1);
      await page.locator('#search').fill('');await page.locator('#status').selectOption('SKIP');assert.equal(await page.locator('article:visible').count(),1);
      await page.locator('details summary').filter({hasText:'methods:'}).click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`Report overflow at ${width}px`);
    }
  }finally{await browser.close();}
});
