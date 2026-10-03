const { contextBridge, ipcRenderer } = require('electron');

function safeSuggestedName(value) {
  return String(value || 'nocturne-project.nocturnedump').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
}

contextBridge.exposeInMainWorld('nocturneElectron', {
  isNocturneElectron: true,
  chooseBackupDirectory: () => ipcRenderer.invoke('nocturne:backup-directory'),
  writeBackup: (data, name) => ipcRenderer.invoke('nocturne:backup-write', data, name),
  readBackup: name => ipcRenderer.invoke('nocturne:backup-read', name),
  openDumpFile: () => ipcRenderer.invoke('nocturne:open-dump-file'),
  takeOpenFiles: () => ipcRenderer.invoke('nocturne:take-open-files'),
  onOpenFilesPending: callback => {
    const listener = () => callback();
    ipcRenderer.on('nocturne:open-files-pending', listener);
    return () => ipcRenderer.removeListener('nocturne:open-files-pending', listener);
  },
  saveDumpFile: (data, suggestedName) => {
    if (typeof data !== 'string') return Promise.reject(new Error('Dump data must be a string.'));
    if (data.length > 80 * 1024 * 1024) return Promise.reject(new Error('Dump data is too large.'));
    return ipcRenderer.invoke('nocturne:save-dump-file', data, safeSuggestedName(suggestedName));
  },
  getPlatformInfo: () => ipcRenderer.invoke('nocturne:get-platform-info'),
  syncServerStatus: () => ipcRenderer.invoke('nocturne:sync-server-status'),
  syncServerStart: () => ipcRenderer.invoke('nocturne:sync-server-start'),
  syncServerStop: () => ipcRenderer.invoke('nocturne:sync-server-stop'),
  syncServerRefreshToken: () => ipcRenderer.invoke('nocturne:sync-server-refresh-token'),
  syncServerConnectionInfo: () => ipcRenderer.invoke('nocturne:sync-server-connection-info'),
  showItemInFolder: (filePath) => {
    if (typeof filePath !== 'string' || filePath.length > 4096) return Promise.resolve(false);
    return ipcRenderer.invoke('nocturne:show-item-in-folder', filePath);
  },
  saveGitSnapshot: (data, projectName) => {
    if (typeof data !== 'string') return Promise.resolve(false);
    return ipcRenderer.invoke('nocturne:git-commit', data, safeSuggestedName(projectName));
  },
  windowMinimize: () => ipcRenderer.invoke('nocturne:window-minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('nocturne:window-maximize'),
  windowClose: () => ipcRenderer.invoke('nocturne:window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('nocturne:window-is-maximized'),
  onWindowMaximizedState: (callback) => {
    const listener = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on('nocturne:window-maximized-state', listener);
    return () => ipcRenderer.removeListener('nocturne:window-maximized-state', listener);
  },
});
