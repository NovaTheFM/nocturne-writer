import { encryptJson, decryptJson } from './crypto.js';

const SENSITIVE = new Set(['docs', 'drafts', 'lore', 'snapshots', 'floatingNotes', 'reviewMarks', 'typoRules', 'trash', 'backups', 'syncQueue', 'syncConflicts']);

export function stripSecrets(settings = {}) {
  const clean = structuredClone(settings);
  clean.aiKey = '';
  clean.customAiProviders = (clean.customAiProviders || []).map(provider => ({ ...provider, key: '' }));
  return clean;
}

export async function revealRecord(store, record, password) {
  if (!record?.protectedStore) return record;
  if (!password) return { ...record, locked: true };
  try {
    const decoded = await decryptJson(record.encrypted, password);
    if (store === 'settings' && record.id === 'app') {
      return { id: record.id, value: { ...record.value, ...decoded } };
    }
    return decoded;
  } catch { return { ...record, locked: true }; }
}

export async function protectRecord(store, record, { enabled = false, password = '' } = {}) {
  if (!record || typeof record !== 'object') throw new Error('Некорректная запись базы.');
  if (record.protectedStore) {
    return record;
  }
  if (!enabled) return record;
  if (store === 'settings' && record.id === 'app') {
    const value = stripSecrets(record.value);
    const secrets = { aiKey: record.value.aiKey || '', customAiProviders: record.value.customAiProviders || [] };
    if (!password) return { id: record.id, value };
    return { id: record.id, value, protectedStore: store, encrypted: await encryptJson(secrets, password) };
  }
  if (!(SENSITIVE.has(store) || (store === 'settings' && record.id === 'global-notes'))) return record;
  if (!password) {
    if (record.encrypted && record.locked) return record;
    throw new Error('Введите мастер-пароль для защищённого сохранения.');
  }
  const clean = structuredClone(record);
  delete clean.encrypted; delete clean.locked; delete clean._needsModelSync;
  const metadata = {};
  for (const key of ['id', 'docId', 'folderId', 'order', 'createdAt', 'updatedAt']) {
    if (clean[key] !== undefined) metadata[key] = clean[key];
  }
  return { ...metadata, protectedStore: store, encrypted: await encryptJson(clean, password) };
}
