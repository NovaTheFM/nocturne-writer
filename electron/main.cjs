const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const { createServer } = require('node:http');
const { networkInterfaces, hostname } = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { simpleGit } = require('simple-git');
const { Bonjour } = require('bonjour-service');

const root = path.resolve(__dirname, '..');
let t = source => source;
const interfaceLanguagePath = path.join(root, existsSync(path.join(root, 'app_src', 'src')) ? 'app_src/src/core/i18n.js' : 'src/core/i18n.js');
const interfaceLanguageReady = import(pathToFileURL(interfaceLanguagePath).href).then(module => { t = module.t; return module; });
ipcMain.handle('nocturne:interface-language', async (_event, locale) => {
  if (!['ru', 'uk', 'en'].includes(locale)) throw new Error('Unsupported interface language.');
  (await interfaceLanguageReady).setLocale(locale);
  return true;
});
const devUrl = process.env.NOCTURNE_DEV_URL || process.env.ELECTRON_DEV_URL || '';
if (process.env.NOCTURNE_TEST_PROFILE) app.setPath('userData', path.resolve(process.env.NOCTURNE_TEST_PROFILE));
const associatedExtensions = new Set(['.nocturnedump', '.nocturnmemory', '.nocturnecharacters', '.nocturneplaces', '.nocturnetimelines', '.nocturnenotes', '.nocturnechar', '.nocturneplace', '.nocturnetime', '.nocturnenote', '.nocturned']);
const pendingOpenFiles = [];
function queueOpenFiles(filenames, directory = process.cwd()) {
  for (const filename of filenames) {
    if (typeof filename !== 'string' || filename.startsWith('-') || !associatedExtensions.has(path.extname(filename).toLowerCase())) continue;
    const target = path.resolve(directory, filename);
    if (!pendingOpenFiles.includes(target)) pendingOpenFiles.push(target);
  }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('nocturne:open-files-pending');
}
queueOpenFiles(process.argv.slice(1));
app.on('open-file', (event, filename) => { event.preventDefault(); queueOpenFiles([filename]); });
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', (_event, argv, directory) => {
  queueOpenFiles(argv.slice(1), directory);
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !process.env.NOCTURNE_TEST_PROFILE) { if (win.isMinimized()) win.restore(); win.focus(); }
});
ipcMain.handle('nocturne:take-open-files', async () => {
  const files = [];
  for (const filename of pendingOpenFiles.splice(0)) {
    try {
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size > 80 * 1024 * 1024) throw new Error(t('Файл слишком большой или недоступен.'));
      files.push({ name: path.basename(filename), data: await fs.readFile(filename, 'utf8'), size: stat.size });
    } catch (error) { files.push({ name: path.basename(filename), error: error.message }); }
  }
  return files;
});
let chosenBackupDirectory = null;
const validBackupName = name => typeof name === 'string' && /^nocturne-[\dTZ.-]+\.nocturnedump$/.test(name);
async function backupDirectory() {
  if (!chosenBackupDirectory) {
    try { chosenBackupDirectory = (JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'backup-directory.json'), 'utf8'))).path; } catch {}
  }
  const directory = chosenBackupDirectory || path.join(app.getPath('documents'), 'Nocturne Backups');
  await fs.mkdir(directory, { recursive: true });
  return directory;
}
ipcMain.handle('nocturne:backup-directory', async () => {
  const result = await dialog.showOpenDialog({ title: t('Папка резервных копий'), properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled) return null;
  chosenBackupDirectory = result.filePaths[0];
  await fs.writeFile(path.join(app.getPath('userData'), 'backup-directory.json'), JSON.stringify({ path: chosenBackupDirectory }));
  return { path: chosenBackupDirectory };
});
ipcMain.handle('nocturne:backup-write', async (_event, data, name) => {
  if (!validBackupName(name) || typeof data !== 'string' || data.length > 80 * 1024 * 1024) throw new Error(t('Некорректная резервная копия.'));
  const directory = await backupDirectory(), target = path.join(directory, name), temporary = `${target}.pending`;
  await fs.writeFile(temporary, data, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temporary, target);
  const files = (await fs.readdir(directory, { withFileTypes: true })).filter(file => file.isFile() && validBackupName(file.name)).map(file => file.name).sort().reverse();
  for (const file of files.slice(20)) await fs.unlink(path.join(directory, file));
  return { external: true, path: target };
});
ipcMain.handle('nocturne:backup-read', async (_event, name) => {
  if (!validBackupName(name)) throw new Error(t('Некорректное имя резервной копии.'));
  const target = path.join(await backupDirectory(), name);
  if ((await fs.stat(target)).size > 80 * 1024 * 1024) throw new Error(t('Резервная копия слишком большая.'));
  return fs.readFile(target, 'utf8');
});

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
const SYNC_PROTOCOL_VERSION = 3;
let syncHttpServer = null;
let syncWss = null;
let syncStartedAt = null;
let syncBonjour = null;
let syncPort = Number(process.env.SYNC_PORT || 8787);
let syncToken = randomBytes(16).toString('hex').toUpperCase();
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
      if (message.to && message.to !== client.deviceId) continue;
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
  const sourceRoot = existsSync(path.join(root, 'src')) ? root : path.join(root, 'app_src');
  const { pairingNonce, pairingProof, verifyPairingProof } = await import(pathToFileURL(path.join(sourceRoot, 'src/core/sync-auth.js')).href);
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

  syncWss = new WebSocketServer({ server: syncHttpServer, maxPayload: 32 * 1024 * 1024 });
  syncWss.on('connection', (ws, req) => {
    let paired = false;
    const challenge = pairingNonce();
    const createdAt = Date.now();
    const deadline = setTimeout(() => ws.close(1008, 'Pairing timed out'), 10000);
    let work = Promise.resolve();
    ws.on('error', () => ws.terminate());
    sendWs(ws, { type: 'pair-challenge', protocolVersion: SYNC_PROTOCOL_VERSION, challenge });
    ws.on('message', raw => { work = work.then(() => handleMessage(raw)).catch(() => ws.close(1008, 'Invalid message')); });
    async function handleMessage(raw) {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        sendWs(ws, { type: 'error', message: 'Некорректное JSON-сообщение.' });
        return;
      }

      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
        sendWs(ws, { type: 'error', message: 'Некорректное JSON-сообщение.' }); ws.close(1008, 'Invalid message'); return;
      }
      if (!paired) {
        if (Number(message.protocolVersion || 0) !== SYNC_PROTOCOL_VERSION) {
          sendWs(ws, { type: 'error', message: 'Версия протокола локальной связи не совпадает.' });
          ws.close(1008, 'Invalid protocol version');
          return;
        }
        if (message.type !== 'pair' || Date.now() - createdAt > 10000 || !await verifyPairingProof(message.proof, syncToken, 'client', challenge, message.clientNonce, message.deviceId)) {
          sendWs(ws, { type: 'error', message: 'Неверный код подключения.' });
          ws.close(1008, 'Invalid pairing token');
          return;
        }
        clearTimeout(deadline);
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
        sendWs(ws, { type: 'paired', peer: peers[0] || null, peers, server: syncDiscoveryPayload(), proof: await pairingProof(syncToken, 'server', challenge, message.clientNonce, message.deviceId) });
        broadcastWs(ws, { type: 'peer-joined', peer: pairedPeer(client), from: client.deviceId });
        return;
      }

      const sender = syncClients.get(ws);
      if (!sender) return;
      if (message.type === 'ping') {
        sendWs(ws, { type: 'pong', id: message.id, at: Date.now() });
        return;
      }
      const allowed = new Set(['relay', 'relay-ack', 'project-state-request', 'presence']);
      if (!allowed.has(message.type)) {
        sendWs(ws, { type: 'error', message: `Неподдерживаемый тип сообщения: ${message.type}` });
        return;
      }
      broadcastWs(ws, { ...message, from: sender.deviceId, deviceName: sender.deviceName });
    }

    ws.on('close', () => {
      clearTimeout(deadline);
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
  try {
    syncBonjour = new Bonjour();
    syncBonjour.publish({ name: `Nocturne Sync - ${hostname()}`, type: 'nocturne-sync', protocol: 'tcp', port: syncPort, txt: { protocol: '2', app: 'Nocturne Writer' } });
  } catch (error) { console.warn('LAN advertisement:', error.message); }
  return syncStatusPayload();
}

function stopSyncServer() {
  try { syncBonjour?.destroy(); } catch {}
  syncBonjour = null;
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
  syncToken = randomBytes(16).toString('hex').toUpperCase();
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
    show: !process.env.NOCTURNE_TEST_PROFILE,
    icon: iconPath,
    backgroundColor: '#08080a',
    frame: false,
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
  if (!process.env.NOCTURNE_TEST_PROFILE) win.maximize();
  if (typeof win.removeMenu === 'function') win.removeMenu();

  // Send window maximize states to the renderer
  win.on('maximize', () => {
    win.webContents.send('nocturne:window-maximized-state', true);
  });
  win.on('unmaximize', () => {
    win.webContents.send('nocturne:window-maximized-state', false);
  });

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
    title: t('Открыть резервную копию Nocturne'),
    properties: ['openFile'],
    filters: [
      { name: t('Резервная копия Nocturne'), extensions: ['nocturnedump', 'json'] },
      { name: t('Все файлы'), extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const stat = await fs.stat(filePath);
  if (stat.size > 80 * 1024 * 1024) throw new Error(t('Резервная копия слишком большая.'));
  return { name: path.basename(filePath), path: filePath, size: stat.size, data: await fs.readFile(filePath, 'utf8') };
});

ipcMain.handle('nocturne:save-dump-file', async (_event, data, suggestedName = 'nocturne-project.nocturnedump') => {
  if (typeof data !== 'string') throw new Error(t('Некорректные данные резервной копии.'));
  const safeName = String(suggestedName || 'nocturne-project.nocturnedump').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
  const result = await dialog.showSaveDialog({
    title: t('Сохранить резервную копию Nocturne'),
    defaultPath: safeName.endsWith('.nocturnedump') ? safeName : `${safeName}.nocturnedump`,
    filters: [{ name: t('Резервная копия Nocturne'), extensions: ['nocturnedump'] }],
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

ipcMain.handle('nocturne:window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});
ipcMain.handle('nocturne:window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (win.isMaximized()) {
      win.unmaximize();
      return false;
    } else {
      win.maximize();
      return true;
    }
  }
  return false;
});
ipcMain.handle('nocturne:window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});
ipcMain.handle('nocturne:window-is-maximized', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? win.isMaximized() : false;
});
