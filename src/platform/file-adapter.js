import { t, ui, msg } from '../core/i18n.js';
import { detectRuntime, getRuntimeInfo, nativePlugins } from './runtime.js';

function downloadBlob(blob, suggestedName = 'nocturne-file.txt') {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function readFileWithInput(accept = '*/*') {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      try {
        resolve({ name: file.name, data: await file.text(), size: file.size, type: file.type });
      } catch (error) {
        reject(error);
      }
    }, { once: true });
    input.addEventListener('cancel', () => { input.remove(); resolve(null); }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

async function saveWithCapacitor(data, suggestedName, mime) {
  const fs = nativePlugins.Filesystem;
  const share = nativePlugins.Share;
  if (!fs) return false;
  const encoded = btoa(unescape(encodeURIComponent(String(data || ''))));
  const fileName = suggestedName || `nocturne-${Date.now()}.txt`;
  const directory = 'CACHE';
  const saved = await fs.writeFile({ path: fileName, data: encoded, directory });
  if (share?.share) {
    await share.share({
      title: fileName,
      text: 'Nocturne Writer export',
      url: saved.uri,
      dialogTitle: 'Share Nocturne export',
    });
  }
  return { path: saved.uri || fileName, mime };
}

export async function saveBlobFile(blob, suggestedName) {
  if (detectRuntime().isCapacitor) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    const fileName = String(suggestedName).replace(/[\\/:*?"<>|]/g, '_');
    const saved = await nativePlugins.Filesystem.writeFile({ path: `exports/${fileName}`, data: btoa(binary), directory: 'CACHE', recursive: true });
    await nativePlugins.Share.share({ title: fileName, url: saved.uri, dialogTitle: t('Сохранить или отправить файл') });
    return { path: saved.uri };
  }
  downloadBlob(blob, suggestedName);
  return { path: suggestedName, fallback: 'browser-download' };
}

export async function saveTextFile(data, suggestedName = 'nocturne.txt', mime = 'text/plain;charset=utf-8') {
  const runtime = detectRuntime();
  if (runtime.isElectron && window.nocturneElectron?.saveDumpFile) {
    return window.nocturneElectron.saveDumpFile(String(data || ''), suggestedName);
  }
  if (runtime.isCapacitor) {
    const result = await saveWithCapacitor(data, suggestedName, mime);
    if (!result) throw new Error(t('Не удалось сохранить файл на телефоне.'));
    return result;
  }
  downloadBlob(new Blob([String(data || '')], { type: mime }), suggestedName);
  return { path: suggestedName, fallback: 'browser-download' };
}

export async function openTextFile(accept = '.txt,application/json') {
  const runtime = detectRuntime();
  if (runtime.isElectron && window.nocturneElectron?.openDumpFile) {
    return window.nocturneElectron.openDumpFile();
  }
  return readFileWithInput(accept);
}

export async function exportProjectDump(data, options = {}) {
  return saveTextFile(data, options.suggestedName || `nocturne-${Date.now()}.nocturnedump`, 'application/json;charset=utf-8');
}

export async function importProjectDump(options = {}) {
  return openTextFile(options.accept || '.nocturnedump,application/json');
}

export async function shareFileOrText(data, options = {}) {
  const runtime = detectRuntime();
  if (runtime.isCapacitor) {
    return nativePlugins.Share.share({
      title: options.title || 'Nocturne Writer',
      text: String(data || ''),
      dialogTitle: options.dialogTitle || 'Share',
    });
  }
  if (navigator.share) {
    return navigator.share({ title: options.title || 'Nocturne Writer', text: String(data || '') });
  }
  return saveTextFile(data, options.suggestedName || 'nocturne-share.txt', options.mime || 'text/plain;charset=utf-8');
}

export async function takeOpenFiles() {
  if (!detectRuntime().isElectron) return [];
  return window.nocturneElectron.takeOpenFiles?.() || [];
}

export function onOpenFilesPending(callback) {
  if (!detectRuntime().isElectron) return () => {};
  return window.nocturneElectron.onOpenFilesPending?.(callback) || (() => {});
}

let backupDirectoryHandle = null;
export async function controlSyncServer(action = 'status') {
  const methods = { status: 'syncServerStatus', start: 'syncServerStart', stop: 'syncServerStop', 'refresh-token': 'syncServerRefreshToken', 'connection-info': 'syncServerConnectionInfo' };
  if (!methods[action]) throw new Error(t('Неизвестное действие сервера.'));
  if (detectRuntime().isElectron) return window.nocturneElectron[methods[action]]();
  if (detectRuntime().isCapacitor || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error(t('Сервер запускается в приложении на компьютере.'));
  const capability = await (await fetch('/sync/control-token', { signal: AbortSignal.timeout(5000) })).json();
  if (!capability.token) throw new Error(t('Управление сервером недоступно.'));
  const response = await fetch(`/sync/server/${action}`, { method: ['status', 'connection-info'].includes(action) ? 'GET' : 'POST', headers: { 'x-nocturne-control-token': capability.token }, signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || t('Не удалось управлять сервером.'));
  return result;
}
export async function printHtmlDocument(html, title) {
  if (detectRuntime().isCapacitor) return nativePlugins.NocturneLan.printHtml({ html, title });
  const win = window.open('', '_blank');
  if (!win) throw new Error(t('Разрешите открытие окна печати в браузере.'));
  win.document.write(html); win.document.close();
  await win.document.fonts.ready;
  win.focus(); win.print();
  return true;
}
const backupName = name => /^nocturne-[\dTZ.-]+\.nocturnedump$/.test(name);
export async function chooseBackupDirectory(db) {
  if (detectRuntime().isElectron) return window.nocturneElectron.chooseBackupDirectory();
  if (detectRuntime().isCapacitor) return { path: 'Documents/Nocturne Backups' };
  if (!window.showDirectoryPicker) throw new Error(t('Автоматические внешние копии доступны в Chrome, Edge и приложениях для ПК и Android. Здесь можно скачать копию проекта.'));
  backupDirectoryHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'nocturne-backups' });
  await db.put('settings', { id: 'backup-directory', handle: backupDirectoryHandle });
  return { path: backupDirectoryHandle.name };
}
export async function initializeBackupDirectory(db) {
  backupDirectoryHandle = (await db.get('settings', 'backup-directory'))?.handle || null;
}
export async function writeBackup(data, name) {
  if (!backupName(name)) throw new Error(t('Некорректное имя резервной копии.'));
  if (detectRuntime().isElectron) return window.nocturneElectron.writeBackup(data, name);
  if (detectRuntime().isCapacitor) {
    const fs = nativePlugins.Filesystem, path = 'Nocturne Backups';
    const result = await fs.writeFile({ path: `${path}/${name}`, data, encoding: 'utf8', directory: 'DOCUMENTS', recursive: true });
    const files = (await fs.readdir({ path, directory: 'DOCUMENTS' })).files.filter(file => backupName(file.name)).sort((a, b) => b.name.localeCompare(a.name));
    for (const file of files.slice(20)) await fs.deleteFile({ path: `${path}/${file.name}`, directory: 'DOCUMENTS' });
    return { external: true, path: result.uri };
  }
  if (!backupDirectoryHandle || await backupDirectoryHandle.queryPermission({ mode: 'readwrite' }) !== 'granted') return { external: false };
  const handle = await backupDirectoryHandle.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data); await writable.close();
  const names = [];
  for await (const [fileName, entry] of backupDirectoryHandle.entries()) if (entry.kind === 'file' && backupName(fileName)) names.push(fileName);
  for (const fileName of names.sort().reverse().slice(20)) await backupDirectoryHandle.removeEntry(fileName);
  return { external: true, path: `${backupDirectoryHandle.name}/${name}` };
}
export async function readBackup(name) {
  if (!backupName(name)) throw new Error(t('Некорректное имя резервной копии.'));
  if (detectRuntime().isElectron) return window.nocturneElectron.readBackup(name);
  if (detectRuntime().isCapacitor) return (await nativePlugins.Filesystem.readFile({ path: `Nocturne Backups/${name}`, directory: 'DOCUMENTS', encoding: 'utf8' })).data;
  if (!backupDirectoryHandle) throw new Error(t('Подключите папку, в которой хранится копия.'));
  return (await (await backupDirectoryHandle.getFileHandle(name)).getFile()).text();
}

export async function getPlatformInfo() {
  if (window.nocturneElectron?.getPlatformInfo) {
    return window.nocturneElectron.getPlatformInfo();
  }
  return getRuntimeInfo();
}

export async function saveGitSnapshot(data, projectName) {
  const runtime = detectRuntime();
  if (runtime.isElectron && window.nocturneElectron?.saveGitSnapshot) {
    try {
      return await window.nocturneElectron.saveGitSnapshot(data, projectName);
    } catch (err) {
      console.warn('Failed to save git snapshot:', err);
    }
  }
  return false;
}

export const platformFiles = {
  setInterfaceLanguage: locale => window.nocturneElectron?.setInterfaceLanguage?.(locale) ?? Promise.resolve(),
  takeOpenFiles, onOpenFilesPending,
  controlSyncServer,
  printHtmlDocument,
  initializeBackupDirectory, chooseBackupDirectory, writeBackup, readBackup,
  saveBlobFile,
  exportProjectDump,
  importProjectDump,
  saveTextFile,
  openTextFile,
  shareFileOrText,
  getPlatformInfo,
  saveGitSnapshot,
};
