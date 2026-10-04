import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { PROJECT_CHECKS, ARTIFACT_CHECKS } from './qa/checks.mjs';

const selected = [...PROJECT_CHECKS, ...(process.argv.includes('--artifacts') ? ARTIFACT_CHECKS : [])];
const checks = selected.map(({ id, args, executable, timeout }) => [id, args, executable, timeout]);
const results = [];
await mkdir('release/qa', { recursive: true });
for (const [name, args, executable = process.execPath, timeout = 120_000] of checks) {
  const started = Date.now();
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  await writeFile(`release/qa/${name}.log`, output);
  results.push({ name, passed: result.status === 0, durationMs: Date.now() - started, error: result.error?.message });
  console.log(`${name}: ${result.status === 0 ? 'PASS' : 'FAIL'} (${Date.now() - started} ms)`);
  if (result.status !== 0) console.error(output.slice(-6000));
}
await writeFile('release/qa/verification.json', JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
