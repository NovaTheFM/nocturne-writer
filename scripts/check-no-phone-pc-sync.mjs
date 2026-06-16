import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [
  {
    file: 'src/main.js',
    patterns: [
      /openSyncPanel\s*\(/,
      /renderDesktopSyncCenter\s*\(/,
      /renderMobileSync\s*\(/,
      /connectLocalSync/i,
      /syncStatusLabel\s*\(/,
      /renderSyncDeviceCard\s*\(/,
      /renderSyncMergePreview\s*\(/,
      /data-action="sync-/,
      /mobile-open-sync/,
      /sync-center-modal/,
    ],
  },
  {
    file: 'src/features/command-palette.js',
    patterns: [
      /sync-panel/,
      /Связь с компьютером/,
      /Локальная синхронизация по Wi-Fi/,
      /openSyncPanel/,
      /openMobilePanel\('sync'/,
    ],
  },
  {
    file: 'electron/main.cjs',
    patterns: [
      /WebSocketServer/,
      /nocturne:sync-server-/,
      /startSyncServer/,
      /Nocturne Writer LAN Sync/,
      /nocturne-sync/,
    ],
  },
  {
    file: 'electron/preload.cjs',
    patterns: [
      /syncServerStatus/,
      /nocturne:sync-server-/,
    ],
  },
  {
    file: 'web2exe_fixed.py',
    patterns: [
      /sync-server\.mjs/,
      /bonjour-service/,
      /node_modules\/ws/,
    ],
  },
  {
    file: 'package.json',
    patterns: [
      /"sync:server"/,
      /"bonjour-service"/,
      /"ws"/,
      /src\/features\/local-sync\.js/,
      /scripts\/sync-server\.mjs/,
    ],
  },
];

const failures = [];

for (const check of checks) {
  const source = readFileSync(path.join(ROOT, check.file), 'utf8');
  for (const pattern of check.patterns) {
    if (pattern.test(source)) failures.push(`${check.file}: ${pattern}`);
  }
}

if (failures.length) {
  console.error(`Phone-PC sync surface is still present:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log('No phone-PC sync surface found.');
