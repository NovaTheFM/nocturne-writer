import { detectRuntime, getRuntimeInfo } from './runtime.js';

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
    document.body.appendChild(input);
    input.click();
  });
}

async function saveWithCapacitor(data, suggestedName, mime) {
  const fs = window.Capacitor?.Plugins?.Filesystem;
  const share = window.Capacitor?.Plugins?.Share;
  if (!fs) return false;
  const encoded = btoa(unescape(encodeURIComponent(String(data || ''))));
  const fileName = suggestedName || `nocturne-${Date.now()}.txt`;
  const directory = window.Capacitor?.FilesystemDirectory?.Documents || 'DOCUMENTS';
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

export async function saveTextFile(data, suggestedName = 'nocturne.txt', mime = 'text/plain;charset=utf-8') {
  const runtime = detectRuntime();
  if (runtime.isElectron && window.nocturneElectron?.saveDumpFile) {
    return window.nocturneElectron.saveDumpFile(String(data || ''), suggestedName);
  }
  if (runtime.isCapacitor) {
    try {
      const result = await saveWithCapacitor(data, suggestedName, mime);
      if (result) return result;
    } catch (error) {
      console.warn('Capacitor file save failed, falling back to browser download.', error);
    }
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
  if (runtime.isCapacitor && window.Capacitor?.Plugins?.Share?.share) {
    return window.Capacitor.Plugins.Share.share({
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

export async function getPlatformInfo() {
  if (window.nocturneElectron?.getPlatformInfo) {
    return window.nocturneElectron.getPlatformInfo();
  }
  return getRuntimeInfo();
}

export const platformFiles = {
  exportProjectDump,
  importProjectDump,
  saveTextFile,
  openTextFile,
  shareFileOrText,
  getPlatformInfo,
};
