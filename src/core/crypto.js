import { t } from './i18n.js';
const enc = new TextEncoder();
const dec = new TextDecoder();

async function keyFromPassword(password, salt) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function bytesToBase64(bytes) {
  const view = new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < view.length; i += chunkSize) {
    binary += String.fromCharCode(...view.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  if (typeof value !== 'string' || !value) throw new Error(t('Зашифрованные данные неполны.'));
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

export async function encryptJson(payload, password) {
  if (!password) throw new Error(t('Введите мастер-пароль для шифрования.'));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFromPassword(password, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  return { salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(data) };
}

export async function decryptJson(payload, password) {
  if (!password) throw new Error(t('Введите мастер-пароль для расшифровки.'));
  if (!payload?.salt || !payload?.iv || !payload?.data) throw new Error(t('Зашифрованные данные неполны.'));
  const salt = base64ToBytes(payload.salt);
  const iv = base64ToBytes(payload.iv);
  const key = await keyFromPassword(password, salt);
  try {
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBytes(payload.data));
    return JSON.parse(dec.decode(data));
  } catch {
    throw new Error(t('Не удалось расшифровать данные. Проверьте мастер-пароль.'));
  }
}
