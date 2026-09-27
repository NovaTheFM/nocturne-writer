import { Capacitor, nativePlugins } from '../vendor/capacitor/native.bundle.js';

export { nativePlugins };

export function detectRuntime() {
  const electronApi = window.nocturneElectron || null;
  const capacitor = Capacitor;
  const platform = capacitor?.getPlatform?.() || '';
  const userAgent = navigator.userAgent || '';
  const isElectron = !!electronApi?.isNocturneElectron;
  const isCapacitor = !!capacitor?.isNativePlatform?.();
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

export async function configureNativeBars() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await nativePlugins.StatusBar.show();
    await nativePlugins.StatusBar.setStyle({ style: 'DARK' });
    await nativePlugins.StatusBar.setBackgroundColor({ color: '#101017' });
    await nativePlugins.NavigationBar.show();
    await nativePlugins.NavigationBar.setColor({ color: '#101017', darkButtons: false });
  } catch (error) { console.warn('Native system bars:', error.message); }
}

export function bindNativeLifecycle({ onBack, onSuspend, onResume }) {
  if (!Capacitor.isNativePlatform()) return;
  nativePlugins.App.addListener('backButton', onBack);
  nativePlugins.App.addListener('appStateChange', ({ isActive }) => isActive ? onResume?.() : onSuspend?.());
}

export async function discoverNativeLan(onDevice) {
  if (!Capacitor.isNativePlatform()) return false;
  await nativePlugins.NocturneLan.addListener('deviceFound', onDevice);
  await nativePlugins.NocturneLan.discover();
  return true;
}

export function getRuntimeInfo() {
  const runtime = detectRuntime();
  return {
    ...runtime,
    userAgent: navigator.userAgent || '',
    language: navigator.language || '',
  };
}
