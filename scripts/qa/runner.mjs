import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readdir, readFile, stat, copyFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import net from 'node:net';

export async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(filename));
    else if (entry.isFile()) result.push(filename);
  }
  return result.sort();
}

export async function sourceFingerprint(root) {
  const filenames = ['index.html', 'package.json', 'capacitor.config.json', 'android/app/src/main/AndroidManifest.xml'];
  for (const directory of ['src', 'scripts', 'android/app/src/main/java', 'android/app/src/main/res']) {
    filenames.push(...(await filesUnder(join(root, directory))).filter(filename=>directory!=='scripts'||/\.(mjs|js|cjs|py)$/.test(filename)).map(filename => filename.slice(root.length + 1).replaceAll('\\', '/')));
  }
  const hash = createHash('sha256');
  for (const filename of filenames.sort()) hash.update(filename).update('\0').update(await readFile(join(root, filename)));
  return hash.digest('hex');
}

export async function availablePort(port = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { const actual = server.address().port; server.close(error => error ? reject(error) : resolve(actual)); });
  });
}

export function killOwnedProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

export async function runCheck(check, { root, directory, env = {}, onChild = () => {}, heartbeat = true }) {
  await mkdir(directory, { recursive: true });
  const started = Date.now(), logPath = join(directory, 'output.log');
  const log = createWriteStream(logPath);
  let tail = '', written = 0, terminated = false;
  const result = await new Promise(resolve => {
    const child = spawn(check.executable || process.execPath, check.args, { cwd: root, env: { ...process.env, ...env }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    onChild(child);
    let finished = false;
    const finish = (code, signal, error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearInterval(pulse);
      resolve({ status: terminated ? 'TIMEOUT' : code === 0 && !error ? 'PASS' : 'FAIL', exitCode: code, signal, error: terminated ? `Exceeded ${check.timeout} ms` : error?.message, tail, durationMs: Date.now() - started });
    };
    const capture = data => {
      const value = data.toString(); tail = (tail + value).slice(-64_000);
      if (written < 16_000_000) { log.write(data); written += data.length; }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timer = setTimeout(() => { terminated = true; killOwnedProcess(child); finish(null, 'TIMEOUT'); }, check.timeout || 120_000);
    const pulse = heartbeat ? setInterval(() => console.log(`RUN ${check.id}: ${Math.round((Date.now() - started) / 1000)}s`), 20_000) : null;
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
  });
  await new Promise(resolve => log.end(resolve));
  onChild(null);
  return { ...result, startedAt: new Date(started).toISOString(), logPath };
}

export async function archiveEvidence(qaRoot, target, since) {
  const copied = [];
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (/^(app-tester|mobile-preview|native-backups|.*profile.*|\.active)/.test(entry.name)) continue;
      const name = join(relative, entry.name), source = join(directory, entry.name);
      if (source === dirname(target)) continue;
      if (entry.isDirectory()) await visit(source, name);
      else if (entry.isFile() && /\.(json|png|zip|log)$/.test(entry.name)) {
        const metadata = await stat(source);
        if (metadata.mtimeMs < since - 100 || metadata.size > 20_000_000) continue;
        const destination = join(target, 'artifacts', name);
        await mkdir(dirname(destination), { recursive: true }); await copyFile(source, destination);
        copied.push(destination);
      }
    }
  }
  await visit(qaRoot);
  return copied;
}
