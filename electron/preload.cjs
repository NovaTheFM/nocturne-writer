const { contextBridge, ipcRenderer } = require('electron');

function safeSuggestedName(value) {
  return String(value || 'nocturne-project.nocturnedump').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
}

contextBridge.exposeInMainWorld('nocturneElectron', {
  isNocturneElectron: true,
  openDumpFile: () => ipcRenderer.invoke('nocturne:open-dump-file'),
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
});
