export function detectRuntime() {
  const electronApi = window.nocturneElectron || null;
  const capacitor = window.Capacitor || null;
  const platform = capacitor?.getPlatform?.() || '';
  const userAgent = navigator.userAgent || '';
  const isElectron = !!electronApi?.isNocturneElectron;
  const isCapacitor = !!capacitor?.isNativePlatform?.() || !!capacitor?.Plugins;
  const isAndroid = platform === 'android' || /Android/i.test(userAgent);
  const supportsNativeShare = !!navigator.share || !!capacitor?.Plugins?.Share;
  return {
    isElectron,
    isCapacitor,
    isAndroid,
    isBrowser: !isElectron && !isCapacitor,
    platform: isElectron ? 'electron' : isCapacitor ? platform || 'capacitor' : 'browser',
    supportsNativeFileDialogs: isElectron || !!capacitor?.Plugins?.Filesystem,
    supportsNativeShare,
    supportsFilesystem: isElectron || !!capacitor?.Plugins?.Filesystem,
    hasWebShare: !!navigator.share,
  };
}

export function getRuntimeInfo() {
  const runtime = detectRuntime();
  return {
    ...runtime,
    userAgent: navigator.userAgent || '',
    language: navigator.language || '',
  };
}
