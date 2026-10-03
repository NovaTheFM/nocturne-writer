export const SYNC_PROTOCOL_VERSION = 3;
const encoder = new TextEncoder();

export function pairingNonce() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function pairingKey(token) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Код подключения отсутствует.');
  return crypto.subtle.importKey('raw', encoder.encode(token.trim().toUpperCase()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function transcript(role, challenge, clientNonce, deviceId) {
  if (!['client', 'server'].includes(role) || !/^[a-f\d]{64}$/u.test(challenge) || !/^[a-f\d]{64}$/u.test(clientNonce) || typeof deviceId !== 'string' || !/^[\w.:-]{1,240}$/u.test(deviceId)) throw new Error('Некорректный запрос подключения.');
  return encoder.encode(JSON.stringify(['nocturne-pair', SYNC_PROTOCOL_VERSION, role, challenge, clientNonce, deviceId]));
}

export async function pairingProof(token, role, challenge, clientNonce, deviceId) {
  const signed = await crypto.subtle.sign('HMAC', await pairingKey(token), transcript(role, challenge, clientNonce, deviceId));
  return [...new Uint8Array(signed)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyPairingProof(proof, token, role, challenge, clientNonce, deviceId) {
  if (typeof proof !== 'string' || !/^[a-f\d]{64}$/u.test(proof)) return false;
  const bytes = Uint8Array.from(proof.match(/../gu), byte => parseInt(byte, 16));
  return crypto.subtle.verify('HMAC', await pairingKey(token), bytes, transcript(role, challenge, clientNonce, deviceId));
}
