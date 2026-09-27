import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const port = Number(process.env.PORT || 5173);
const controlToken = randomBytes(32).toString('hex');
const __dirname = dirname(fileURLToPath(import.meta.url));
const syncScript = join(__dirname, 'scripts', 'sync-server.mjs');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

let syncProcess = null;
let syncStartedAt = null;
let syncPort = Number(process.env.SYNC_PORT || 8787);
let syncToken = randomBytes(9).toString('hex').toUpperCase();
const syncDeviceId = process.env.NOCTURNE_SYNC_DEVICE_ID || randomBytes(16).toString('hex');
const syncPublicDeviceId = `nd-${createHash('sha256').update(syncDeviceId).digest('hex').slice(0, 12)}`;
let syncOutput = '';

function localAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

function isLoopbackAddress(address = '') {
  return [
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
  ].includes(address) || address.startsWith('::ffff:127.');
}

function hostName(value = '') {
  const host = String(value).split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  return host || 'localhost';
}

function isAllowedHostHeader(value = '') {
  const host = hostName(value);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isAllowedOrigin(value = '') {
  if (!value) return false;
  try {
    const url = new URL(value);
    return isAllowedHostHeader(url.host) && Number(url.port || 80) === port;
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function controlAllowed(req, { requireToken = true, requirePostOrigin = false } = {}) {
  if (!isLoopbackAddress(req.socket.remoteAddress || '')) {
    return { ok: false, status: 403, error: 'Control bridge is loopback-only.' };
  }
  if (!isAllowedHostHeader(req.headers.host || '')) {
    return { ok: false, status: 403, error: 'Invalid Host header.' };
  }
  if (requirePostOrigin && !isAllowedOrigin(req.headers.origin || '')) {
    return { ok: false, status: 403, error: 'Invalid Origin header.' };
  }
  if (requireToken && req.headers['x-nocturne-control-token'] !== controlToken) {
    return { ok: false, status: 401, error: 'Invalid local control token.' };
  }
  return { ok: true };
}

function syncStatusPayload() {
  return {
    capability: 'local-node-control',
    canControl: true,
    running: Boolean(syncProcess && !syncProcess.killed),
    port: syncPort,
    token: syncToken,
    publicDeviceId: syncPublicDeviceId,
    lanIps: localAddresses(),
    startedAt: syncStartedAt,
    pid: syncProcess?.pid || null,
    output: syncOutput.slice(-2500),
  };
}

function startSyncServer() {
  if (syncProcess && !syncProcess.killed) return;
  syncOutput = '';
  syncStartedAt = Date.now();
  syncProcess = spawn(process.execPath, [syncScript], {
    cwd: root,
    env: {
      ...process.env,
      SYNC_PORT: String(syncPort),
      SYNC_TOKEN: syncToken,
      NOCTURNE_SYNC_DEVICE_NAME: process.env.NOCTURNE_SYNC_DEVICE_NAME || 'Nocturne Desktop',
      NOCTURNE_SYNC_DEVICE_TYPE: 'computer',
      NOCTURNE_SYNC_DEVICE_ID: syncDeviceId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const appendOutput = (chunk) => {
    syncOutput = `${syncOutput}${String(chunk)}`.slice(-5000);
  };
  syncProcess.stdout?.on('data', appendOutput);
  syncProcess.stderr?.on('data', appendOutput);
  syncProcess.on('exit', (code, signal) => {
    appendOutput(`\n[sync-control] broker exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
    syncProcess = null;
  });
}

function stopSyncServer() {
  if (!syncProcess || syncProcess.killed) return;
  syncProcess.kill();
  syncProcess = null;
  syncStartedAt = null;
}

function refreshSyncToken() {
  syncToken = randomBytes(9).toString('hex').toUpperCase();
  if (syncProcess && !syncProcess.killed) {
    stopSyncServer();
    startSyncServer();
  }
}

async function handleControl(req, res, url) {
  if (url.pathname === '/sync/control-token' && req.method === 'GET') {
    const allowed = controlAllowed(req, { requireToken: false });
    if (!allowed.ok) return sendJson(res, allowed.status, { error: allowed.error });
    return sendJson(res, 200, { token: controlToken, capability: 'local-node-control' });
  }

  if (url.pathname === '/sync/server/status' && req.method === 'GET') {
    const allowed = controlAllowed(req);
    if (!allowed.ok) return sendJson(res, allowed.status, { error: allowed.error });
    return sendJson(res, 200, syncStatusPayload());
  }

  if (url.pathname === '/sync/server/connection-info' && req.method === 'GET') {
    const allowed = controlAllowed(req);
    if (!allowed.ok) return sendJson(res, allowed.status, { error: allowed.error });
    return sendJson(res, 200, syncStatusPayload());
  }

  const postAllowed = controlAllowed(req, { requirePostOrigin: true });
  if (!postAllowed.ok) return sendJson(res, postAllowed.status, { error: postAllowed.error });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed.' });

  if (url.pathname === '/sync/server/start') {
    startSyncServer();
    return sendJson(res, 200, syncStatusPayload());
  }
  if (url.pathname === '/sync/server/stop') {
    stopSyncServer();
    return sendJson(res, 200, syncStatusPayload());
  }
  if (url.pathname === '/sync/server/refresh-token') {
    refreshSyncToken();
    return sendJson(res, 200, syncStatusPayload());
  }
  return sendJson(res, 404, { error: 'Unknown control endpoint.' });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname.startsWith('/sync/')) {
      await handleControl(req, res, url);
      return;
    }

    const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = normalize(join(root, requested));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    let data = await readFile(file);
    if (requested.endsWith('.html')) {
      let content = data.toString('utf8');
      const killer = `<script>
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistrations().then(function(regs) {
            for (let r of regs) { r.unregister(); }
          });
        }
      </script>`;
      if (content.includes('<head>')) {
        content = content.replace('<head>', '<head>' + killer);
      } else if (content.includes('<body>')) {
        content = content.replace('<body>', '<body>' + killer);
      } else {
        content = killer + content;
      }
      data = Buffer.from(content, 'utf8');
    }
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Nocturne Writer: http://localhost:${port}`);
  console.log('Local sync control bridge is loopback-only and token-protected.');
});
