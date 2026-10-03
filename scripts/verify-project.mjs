import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const checks = [
  ['syntax', ['scripts/check-source.mjs']],
  ['unit', ['--test', 'scripts/test-database-sync.mjs', 'scripts/test-project-backups.mjs', 'scripts/test-smart-speller.mjs', 'scripts/test-sync-auth.mjs']],
  ['audit-data', ['scripts/test-audit-data.mjs']],
  ['audit-editor', ['scripts/test-audit-editor.mjs']],
  ['audit-sync', ['scripts/test-audit-sync.mjs']],
  ['audit-platform', ['scripts/test-audit-platform.mjs']],
  ['pagination', ['scripts/test-pagination.mjs']],
  ['pagination-interaction', ['scripts/test-pagination-interaction.mjs']],
  ['release-tools', ['scripts/test-release-tools.py'], 'python'],
  ['editor-adapter', ['scripts/test-editor-adapter.mjs']],
  ['ai-context', ['scripts/test-ai-context.mjs']],
  ['reliability', ['scripts/test-reliability.mjs']],
  ['workflow-tools', ['scripts/test-workflow-tools.mjs']],
  ['lan-integration', ['scripts/test-lan-sync.mjs']],
  ['native-desktop', ['scripts/test-native-desktop.mjs']],
  ['offline-assets', ['scripts/test-offline-assets.mjs']],
  ['platform-contract', ['scripts/test-sync-platform.mjs']],
  ['production-assets', ['scripts/test-build.mjs']],
  ['desktop-smoke', ['scripts/desktop-smoke.mjs']],
  ['responsive-ui', ['scripts/ui-qa.mjs']],
  ['mobile-behavior', ['scripts/test-mobile-behavior.mjs']],
  ['interface-revision', ['scripts/test-interface-revision.mjs']],
  ['surface-motion', ['scripts/test-surface-motion.mjs']],
  ['app-motion', ['scripts/test-app-motion.mjs']],
];
if (process.argv.includes('--artifacts')) checks.push(
  ['packaged-desktop', ['scripts/test-native-desktop.mjs', '--packaged']],
  ['android-artifact', ['scripts/inspect-android-artifact.py'], 'python'],
  ['desktop-artifact', ['scripts/inspect-desktop-artifact.mjs']],
);
const results = [];
await mkdir('release/qa', { recursive: true });
for (const [name, args, executable = process.execPath] of checks) {
  const started = Date.now();
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  await writeFile(`release/qa/${name}.log`, output);
  results.push({ name, passed: result.status === 0, durationMs: Date.now() - started, error: result.error?.message });
  console.log(`${name}: ${result.status === 0 ? 'PASS' : 'FAIL'} (${Date.now() - started} ms)`);
  if (result.status !== 0) console.error(output.slice(-6000));
}
await writeFile('release/qa/verification.json', JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
