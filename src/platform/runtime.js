import { Capacitor, nativePlugins } from '../vendor/capacitor/native.bundle.js';
import { tutorialContext } from '../core/tutorial-context.js';

export { nativePlugins };

export function detectRuntime() {
  const electronApi = !tutorialContext && window.nocturneElectron || null;
  const capacitor = Capacitor;
  const platform = capacitor?.getPlatform?.() || '';
  const userAgent = navigator.userAgent || '';
  const isElectron = !!electronApi?.isNocturneElectron;
  const isCapacitor = !tutorialContext && !!capacitor?.isNativePlatform?.();
  const isAndroid = platform === 'android' || /Android/i.test(userAgent);
  const supportsNativeShare = !!navigator.share || isCapacitor;
  return {
    isElectron,
    isCapacitor,
    isAndroid,
    isBrowser: !isElectron && !isCapacitor,
    platform: isElectron ? 'electron' : isCapacitor ? platform || 'capacitor' : 'browser',
    supportsNativeFileDialogs: isElectron || isCapacitor,
    supportsNativeShare,
    supportsFilesystem: isElectron || isCapacitor,
    hasWebShare: !!navigator.share,
  };
}

export function nativeBarColor(color = '#08080a') {
  if (/^#[\da-f]{6}$/i.test(color)) return color;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  if (!context) return '#08080a';
  context.fillStyle = '#08080a'; context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return '#' + [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(channel => channel.toString(16).padStart(2, '0')).join('');
}

export async function configureNativeBars({ light = false, color = '#08080a' } = {}) {
  if (tutorialContext) return;
  if (!Capacitor.isNativePlatform()) return;
  color = nativeBarColor(color);
  try {
    await nativePlugins.StatusBar.show();
    await nativePlugins.StatusBar.setStyle({ style: light ? 'LIGHT' : 'DARK' });
    await nativePlugins.StatusBar.setBackgroundColor({ color });
    await nativePlugins.NavigationBar.show();
    await nativePlugins.NavigationBar.setColor({ color, darkButtons: light });
  } catch (error) { console.warn('Native system bars:', error.message); }
}

export async function minimizeNativeApp() {
  if (Capacitor.isNativePlatform()) await nativePlugins.App.minimizeApp();
}

export function bindNativeLifecycle({ onBack, onSuspend, onResume }) {
  if (tutorialContext) return;
  if (!Capacitor.isNativePlatform()) return;
  nativePlugins.App.addListener('backButton', onBack);
  nativePlugins.App.addListener('appStateChange', ({ isActive }) => isActive ? onResume?.() : onSuspend?.());
}

let discoveryListener = null;
export async function discoverNativeLan(onDevice) {
  if (!Capacitor.isNativePlatform()) return false;
  await discoveryListener?.remove();
  discoveryListener = await nativePlugins.NocturneLan.addListener('deviceFound', onDevice);
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
