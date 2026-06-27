const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const path = require('node:path');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const { createServer } = require('node:http');
const { networkInterfaces, hostname } = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { simpleGit } = require('simple-git');

const root = path.resolve(__dirname, '..');
const devUrl = process.env.NOCTURNE_DEV_URL || process.env.ELECTRON_DEV_URL || '';

ipcMain.handle('nocturne:git-commit', async (_event, dataStr, projectName) => {
  if (typeof dataStr !== 'string') return false;
  try {
    const gitDir = path.join(app.getPath('userData'), 'git-backups');
    if (!existsSync(gitDir)) await fs.mkdir(gitDir, { recursive: true });
    
    const git = simpleGit(gitDir);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      await git.init();
      // Configure dummy user for commits
      await git.addConfig('user.name', 'Nocturne Writer');
      await git.addConfig('user.email', 'autosave@nocturne.local');
    }
    
    const safeName = String(projectName || 'project').replace(/[\\/:*?"<>|]+/g, '_');
    const dumpPath = path.join(gitDir, `${safeName}.nocturnedump.json`);
    
    // Attempt to pretty print if it's valid JSON
    let content = dataStr;
    try {
      const parsed = JSON.parse(dataStr);
      content = JSON.stringify(parsed, null, 2);
    } catch (e) {} // If not JSON, leave as is
    
    await fs.writeFile(dumpPath, content, 'utf8');
    
    await git.add(dumpPath);
    const status = await git.status();
    if (status.staged.length > 0) {
      await git.commit(`Autosave: ${new Date().toISOString()}`);
    }
    return true;
  } catch (err) {
    console.error('Git versioning error:', err);
    return false;
  }
});
const SYNC_PROTOCOL_VERSION = 1;
let syncHttpServer = null;
let syncWss = null;
let syncStartedAt = null;
let syncPort = Number(process.env.SYNC_PORT || 8787);
let syncToken = randomBytes(3).toString('hex').toUpperCase();
const syncDeviceId = process.env.NOCTURNE_SYNC_DEVICE_ID || randomBytes(16).toString('hex');
const syncPublicDeviceId = `nd-${createHash('sha256').update(syncDeviceId).digest('hex').slice(0, 12)}`;
const syncClients = new Map();

function localAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

function sendSyncJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  if (status === 204) {
    res.end();
    return;
  }
  res.end(JSON.stringify(payload, null, 2));
}

function syncDiscoveryPayload() {
  return {
    app: 'Nocturne Writer',
    service: 'nocturne-sync',
    protocolVersion: SYNC_PROTOCOL_VERSION,
    publicDeviceId: syncPublicDeviceId,
    deviceName: hostname() || 'Nocturne Desktop',
    deviceType: 'computer',
    pairingRequired: true,
    port: syncPort,
    serverStartedAt: syncStartedAt,
  };
}

function publicPeer(client) {
  return {
    publicDeviceId: client.publicDeviceId,
    deviceName: client.deviceName,
    deviceType: client.deviceType || client.runtime || 'browser',
    runtime: client.runtime,
    connectedAt: client.connectedAt,
    lastSeenAt: Date.now(),
  };
}

function pairedPeer(client) {
  return { ...publicPeer(client), deviceId: client.deviceId };
}

function sendWs(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

function broadcastWs(sender, message) {
  for (const client of syncClients.values()) {
    if (client.ws !== sender && client.ws.readyState === 1) {
      sendWs(client.ws, { ...message, from: message.from || syncClients.get(sender)?.deviceId });
    }
  }
}

function syncStatusPayload(extra = {}) {
  return {
    capability: 'electron-main-broker',
    canControl: true,
    running: Boolean(syncHttpServer),
    port: String(syncPort),
    token: syncToken,
    publicDeviceId: syncPublicDeviceId,
    lanIps: localAddresses(),
    startedAt: syncStartedAt,
    peers: [...syncClients.values()].map(publicPeer),
    message: syncHttpServer ? 'Сервер запущен внутри Electron.' : 'Сервер готов к запуску внутри Electron.',
    ...extra,
  };
}

async function startSyncServer() {
  if (syncHttpServer) return syncStatusPayload();
  syncStartedAt = Date.now();
  syncHttpServer = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${syncPort}`}`);
    if (req.method === 'OPTIONS') {
      sendSyncJson(res, 204, {});
      return;
    }
    if (url.pathname === '/health') {
      sendSyncJson(res, 200, { ...syncDiscoveryPayload(), status: 'ok', role: 'electron-in-memory-broker' });
      return;
    }
    if (url.pathname === '/discovery') {
      sendSyncJson(res, 200, syncDiscoveryPayload());
      return;
    }
    if (url.pathname === '/peers' || url.pathname === '/status') {
      sendSyncJson(res, 200, {
        ...syncDiscoveryPayload(),
        role: 'electron-in-memory-broker',
        peers: [...syncClients.values()].map(publicPeer),
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Nocturne Writer LAN Sync broker is running inside Electron.');
  });

  let listenError = null;
  syncHttpServer.on('error', (error) => {
    listenError = error;
    console.error('[Nocturne sync] server error:', error);
  });

  syncWss = new WebSocketServer({ server: syncHttpServer });
  syncWss.on('connection', (ws, req) => {
    let paired = false;
    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        sendWs(ws, { type: 'error', message: 'Некорректное JSON-сообщение.' });
        return;
      }

      if (!paired) {
        if (Number(message.protocolVersion || 0) !== SYNC_PROTOCOL_VERSION) {
          sendWs(ws, { type: 'error', message: 'Версия протокола локальной связи не совпадает.' });
          ws.close(1008, 'Invalid protocol version');
          return;
        }
        if (message.type !== 'pair' || String(message.token || '').toUpperCase() !== syncToken) {
          sendWs(ws, { type: 'error', message: 'Неверный код подключения.' });
          ws.close(1008, 'Invalid pairing token');
          return;
        }
        paired = true;
        const client = {
          ws,
          deviceId: String(message.deviceId || `device-${Date.now()}`),
          publicDeviceId: String(message.publicDeviceId || '').slice(0, 80),
          deviceName: String(message.deviceName || 'Устройство').slice(0, 80),
          deviceType: String(message.deviceType || message.runtime || 'browser').slice(0, 40),
          runtime: String(message.runtime || 'browser').slice(0, 40),
          ip: req.socket.remoteAddress,
          connectedAt: Date.now(),
        };
        syncClients.set(ws, client);
        const peers = [...syncClients.values()].filter((item) => item.ws !== ws).map(pairedPeer);
        sendWs(ws, { type: 'paired', peer: peers[0] || null, peers, server: syncDiscoveryPayload() });
        broadcastWs(ws, { type: 'peer-joined', peer: pairedPeer(client), from: client.deviceId });
        return;
      }

      const sender = syncClients.get(ws);
      if (!sender) return;
      if (message.type === 'ping') {
        sendWs(ws, { type: 'pong', id: message.id, at: Date.now() });
        return;
      }
      const allowed = new Set(['project-state-request', 'project-state', 'merge-accepted', 'doc-patch', 'presence']);
      if (!allowed.has(message.type)) {
        sendWs(ws, { type: 'error', message: `Неподдерживаемый тип сообщения: ${message.type}` });
        return;
      }
      broadcastWs(ws, { ...message, from: sender.deviceId, deviceName: sender.deviceName });
    });

    ws.on('close', () => {
      const client = syncClients.get(ws);
      syncClients.delete(ws);
      if (client) broadcastWs(ws, { type: 'peer-left', peer: pairedPeer(client), from: client.deviceId });
    });
  });

  await new Promise((resolve, reject) => {
    syncHttpServer.once('listening', resolve);
    syncHttpServer.once('error', reject);
    syncHttpServer.listen(syncPort, '0.0.0.0');
  }).catch((error) => {
    listenError = error;
  });

  if (listenError) {
    try { syncWss?.close(); } catch {}
    try { syncHttpServer?.close(); } catch {}
    syncWss = null;
    syncHttpServer = null;
    syncStartedAt = null;
    return syncStatusPayload({ running: false, message: `Не удалось запустить сервер: ${listenError.message}` });
  }
  return syncStatusPayload();
}

function stopSyncServer() {
  for (const client of syncClients.values()) {
    try { client.ws.close(); } catch {}
  }
  syncClients.clear();
  try { syncWss?.close(); } catch {}
  try { syncHttpServer?.close(); } catch {}
  syncWss = null;
  syncHttpServer = null;
  syncStartedAt = null;
  return syncStatusPayload();
}

function refreshSyncToken() {
  syncToken = randomBytes(3).toString('hex').toUpperCase();
  return syncStatusPayload();
}

function createWindow() {
  Menu.setApplicationMenu(null);
  const iconPath = existsSync(path.join(__dirname, '..', 'app_src', 'src', 'assets', 'icon.png'))
    ? path.join(__dirname, '..', 'app_src', 'src', 'assets', 'icon.png')
    : path.join(__dirname, '..', 'src', 'assets', 'icon.png');
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: 'Nocturne Writer',
    icon: iconPath,
    backgroundColor: '#08080a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.maximize();
  if (typeof win.removeMenu === 'function') win.removeMenu();

  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    const packagedIndex = path.join(root, 'app_src', 'index.html');
    win.loadFile(existsSync(packagedIndex) ? packagedIndex : path.join(root, 'index.html'));
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopSyncServer();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('nocturne:get-platform-info', () => ({
  isElectron: true,
  platform: process.platform,
  arch: process.arch,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
}));

ipcMain.handle('nocturne:open-dump-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open Nocturne dump',
    properties: ['openFile'],
    filters: [
      { name: 'Nocturne Dump', extensions: ['nocturnedump', 'json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const stat = await fs.stat(filePath);
  if (stat.size > 80 * 1024 * 1024) throw new Error('Dump file is too large.');
  return { name: path.basename(filePath), path: filePath, size: stat.size, data: await fs.readFile(filePath, 'utf8') };
});

ipcMain.handle('nocturne:save-dump-file', async (_event, data, suggestedName = 'nocturne-project.nocturnedump') => {
  if (typeof data !== 'string') throw new Error('Invalid dump data.');
  const safeName = String(suggestedName || 'nocturne-project.nocturnedump').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
  const result = await dialog.showSaveDialog({
    title: 'Save Nocturne dump',
    defaultPath: safeName.endsWith('.nocturnedump') ? safeName : `${safeName}.nocturnedump`,
    filters: [{ name: 'Nocturne Dump', extensions: ['nocturnedump'] }],
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, data, 'utf8');
  return { path: result.filePath, name: path.basename(result.filePath) };
});

ipcMain.handle('nocturne:show-item-in-folder', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false;
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('nocturne:sync-server-status', () => syncStatusPayload());
ipcMain.handle('nocturne:sync-server-start', () => startSyncServer());
ipcMain.handle('nocturne:sync-server-stop', () => stopSyncServer());
ipcMain.handle('nocturne:sync-server-refresh-token', () => refreshSyncToken());
ipcMain.handle('nocturne:sync-server-connection-info', () => syncStatusPayload());
