import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('capacitor.config.json', 'utf8'));
assert.equal(config.appId, 'com.bebranova.nocturne');
assert.equal(config.server.androidScheme, 'http');
assert.equal(config.server.cleartext, true);
const manifest = await readFile('android/app/src/main/AndroidManifest.xml', 'utf8');
assert.match(manifest, /android.permission.INTERNET/);
assert.match(manifest, /android.permission.CHANGE_WIFI_MULTICAST_STATE/);
assert.match(manifest, /adjustResize/);
const native = await readFile('android/app/src/main/java/com/bebranova/nocturne/NocturneLanPlugin.java', 'utf8');
assert.match(native, /_nocturne-sync\._tcp/); assert.match(native, /PrintManager/);
const electron = await readFile('electron/main.cjs', 'utf8');
assert.match(electron, /nocturne:sync-server-start/); assert.match(electron, /bonjour/i);
const preload = await readFile('electron/preload.cjs', 'utf8');
assert.match(preload, /syncServerStart/);
console.log('Android native network, file, print and Electron broker integration present.');
