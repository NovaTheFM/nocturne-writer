import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = join(root, 'android');
const apkSource = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const apkTarget = join(root, 'Nocturne-Writer-debug.apk');
const releaseDir = join(root, 'release', 'android');
const releaseTarget = join(releaseDir, 'Nocturne-Writer-debug.apk');

function gradleWrapper() {
  return process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
}

function sdkFromLocalProperties() {
  const file = join(androidDir, 'local.properties');
  if (!existsSync(file)) return '';
  const match = readFileSync(file, 'utf8').match(/^sdk\.dir=(.+)$/m);
  return match?.[1]?.trim().replace(/\\/g, '/') || '';
}

function run(label, command, options = {}) {
  console.log(`\n==> ${label}`);
  execSync(command, {
    cwd: options.cwd || root,
    stdio: 'inherit',
    shell: true,
    windowsHide: true,
    env: options.env || process.env,
  });
}

const sdkDir = sdkFromLocalProperties();
const env = { ...process.env };
if (process.platform === 'win32' && !env.JAVA_HOME && existsSync('C:/Program Files/Java/jdk-21')) env.JAVA_HOME = 'C:/Program Files/Java/jdk-21';
if (sdkDir) {
  env.ANDROID_HOME = sdkDir;
  env.ANDROID_SDK_ROOT = sdkDir;
}

run('Web build', 'npm run build', { env });
run('Capacitor sync', 'npx cap sync android', { env });
run('Android debug APK', `${gradleWrapper()} assembleDebug`, { cwd: androidDir, env });

if (!existsSync(apkSource)) {
  throw new Error(`APK was not created: ${apkSource}`);
}

mkdirSync(root, { recursive: true });
mkdirSync(releaseDir, { recursive: true });
copyFileSync(apkSource, apkTarget);
copyFileSync(apkSource, releaseTarget);
const size = statSync(apkTarget).size;
console.log(`\nAPK copied to: ${apkTarget}`);
console.log(`APK release copy: ${releaseTarget}`);
console.log(`APK size: ${size} bytes`);
