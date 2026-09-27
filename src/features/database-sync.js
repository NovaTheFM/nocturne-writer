const STORES = ['folders', 'docs', 'lore', 'floatingNotes', 'reviewMarks', 'typoRules', 'snapshots', 'stats', 'trash', 'settings'];
const safeId = value => typeof value === 'string' && /^[\w.:-]{1,240}$/u.test(value);
const allowed = (store, id) => STORES.includes(store) && (store !== 'settings' || id === 'global-notes');
const keyOf = (store, id) => `${store}:${id}`;
const mergeClocks = (a = {}, b = {}) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(id => [id, Math.max(a[id] || 0, b[id] || 0)]));

function compareClocks(a = {}, b = {}) {
  let greater = false, less = false;
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    greater ||= (a[id] || 0) > (b[id] || 0); less ||= (a[id] || 0) < (b[id] || 0);
  }
  return greater && less ? 'concurrent' : greater ? 'newer' : less ? 'older' : 'equal';
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key =>
    !key.startsWith('_') && !['updatedAt', 'renderRevision', 'locked'].includes(key)
    && !(value.ast && ['pmJson', 'summary'].includes(key))
    && !(key === 'align' && value[key] === 'left')
    && !(key === 'level' && value.type === 'heading' && value[key] === 2)
  ).map(key => [key, canonical(value[key])]));
}
async function contentHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function validateRecord(record) {
  if (!record || !allowed(record.store, record.id) || !safeId(record.id) || !record.clock || typeof record.clock !== 'object' || !/^[a-f0-9]{64}$/.test(record.hash)) throw new Error('Некорректная запись синхронизации.');
  for (const [device, revision] of Object.entries(record.clock)) if (!safeId(device) || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Некорректная версия записи.');
  if (!record.deleted && (!record.value || record.value.id !== record.id)) throw new Error('Данные записи синхронизации отсутствуют.');
  const walk = (value, depth = 0) => {
    if (depth > 100) throw new Error('Слишком глубокая структура.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Недопустимое поле.');
      if (['id', 'blockId', 'docId', 'folderId', 'linkedId'].includes(key) && child && !safeId(child)) throw new Error('Недопустимый ID.');
      walk(child, depth + 1);
    }
  };
  walk(record.value);
  walk(record.members);
}

const COLLECTIONS = ['characters', 'locations', 'timeline', 'notes', 'rules'];
function worldEntries(world) {
  const entries = new Map([['metadata', Object.fromEntries(Object.entries(world).filter(([key]) => !COLLECTIONS.includes(key)))]]);
  for (const collection of COLLECTIONS) for (const item of world[collection] || []) {
    if (item?.id) entries.set(`${collection}:${item.id}`, item);
  }
  return entries;
}
async function memberVersions(world, previous = {}, deviceId) {
  const members = {}, entries = worldEntries(world);
  for (const key of new Set([...entries.keys(), ...Object.keys(previous)])) {
    const value = entries.get(key), deleted = !entries.has(key), hash = await contentHash(value || null), old = previous[key];
    if (old?.hash === hash && !!old.deleted === deleted) members[key] = old;
    else members[key] = { hash, deleted, clock: { ...old?.clock, [deviceId]: (old?.clock?.[deviceId] || 0) + 1 } };
  }
  return members;
}
function reconcileWorld(local, incoming, localValue, remoteValue) {
  if (!local.members || !incoming.members || localValue?.locked || remoteValue?.locked || !localValue || !remoteValue) return null;
  const left = worldEntries(localValue), right = worldEntries(remoteValue), members = {}, entries = new Map();
  for (const key of new Set([...Object.keys(local.members), ...Object.keys(incoming.members)])) {
    const a = local.members[key], b = incoming.members[key];
    let chosen, source;
    if (!a) { chosen = b; source = right; }
    else if (!b) { chosen = a; source = left; }
    else if (a.hash === b.hash && !!a.deleted === !!b.deleted) { chosen = { ...a, clock: mergeClocks(a.clock, b.clock) }; source = left; }
    else {
      const order = compareClocks(b.clock, a.clock);
      if (order === 'concurrent' || order === 'equal') return null;
      chosen = order === 'newer' ? b : a; source = order === 'newer' ? right : left;
    }
    members[key] = chosen;
    if (!chosen.deleted) entries.set(key, source.get(key));
  }
  const value = { ...entries.get('metadata') };
  for (const collection of COLLECTIONS) value[collection] = [...entries].filter(([key]) => key.startsWith(`${collection}:`)).sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
  return { value, members };
}

export class DatabaseSync {
  constructor({ db, deviceId, onChange = () => {}, onPending = () => {} }) {
    this.db = db; this.deviceId = deviceId; this.onChange = onChange; this.onPending = onPending;
    this.work = Promise.resolve(); this.incomingWork = Promise.resolve();
  }
  async start() {
    this.db.onMutation = event => {
      if (!allowed(event.store, event.id) || event.origin === 'sync') return;
      this.work = this.work.catch(() => {}).then(() => this.recordLocalChange(event));
      this.work.then(() => this.onPending()).catch(error => this.onChange({ error }));
    };
    for (const store of STORES) for (const record of await this.db.getAllRaw(store)) {
      if (allowed(store, record.id)) await this.recordLocalChange({ store, id: record.id, action: 'put' });
    }
  }
  async recordLocalChange({ store, id, action }) {
    const previous = await this.db.get('syncJournal', keyOf(store, id));
    const decoded = action === 'delete' ? null : await this.db.get(store, id);
    if (decoded?.locked && previous && !previous.deleted) return;
    const deleted = !decoded;
    const hash = await contentHash(decoded?.locked ? (await this.db.getAllRaw(store)).find(row => row.id === id) : decoded);
    if (previous?.hash === hash && previous.deleted === deleted) return;
    const clock = { ...(previous?.clock || {}) };
    clock[this.deviceId] = (clock[this.deviceId] || 0) + 1;
    const members = store === 'lore' && decoded && !decoded.locked ? await memberVersions(decoded, previous?.members, this.deviceId) : undefined;
    await this.db.put('syncJournal', { id: keyOf(store, id), store, recordId: id, clock, hash, deleted, members, updatedAt: Date.now() });
  }
  async buildState() {
    await this.work;
    const raw = new Map();
    for (const store of STORES) for (const record of await this.db.getAllRaw(store)) raw.set(keyOf(store, record.id), record);
    const records = (await this.db.getAll('syncJournal')).map(meta => ({ store: meta.store, id: meta.recordId, clock: meta.clock, hash: meta.hash, members: meta.members, deleted: meta.deleted, value: meta.deleted ? null : raw.get(meta.id) })).filter(record => record.deleted || record.value);
    return { protocol: 2, deviceId: this.deviceId, records };
  }
  receiveState(state) {
    this.incomingWork = this.incomingWork.catch(() => {}).then(() => this.reconcileState(state));
    return this.incomingWork;
  }
  async reconcileState(state) {
    if (state?.protocol !== 2 || !safeId(state.deviceId) || !Array.isArray(state.records)) throw new Error('Неподдерживаемое состояние базы.');
    state.records.forEach(validateRecord);
    await this.work;
    let received = 0, conflicts = 0;
      for (const incoming of state.records) {
        for (let attempt = 0; attempt < 10; attempt++) {
        await this.work;
        const pendingWork = this.work;
        const key = keyOf(incoming.store, incoming.id);
        const local = await this.db.get('syncJournal', key);
        const raw = (await this.db.getAllRaw(incoming.store)).find(record => record.id === incoming.id);
        await this.work;
        if (pendingWork !== this.work) continue;
        const expect = { [incoming.store]: [{ id: incoming.id, value: raw }], syncJournal: [{ id: key, value: local }] };
        try {
        const comparison = local ? compareClocks(incoming.clock, local.clock) : 'newer';
        if (local && incoming.hash === local.hash && !!incoming.deleted === !!local.deleted) {
          const clock = mergeClocks(local.clock, incoming.clock);
          await this.db.atomicWrite({ syncJournal: [{ ...local, clock }] }, { origin: 'sync', expect });
          if (await this.clearResolvedConflicts({ ...incoming, clock })) received++;
          break;
        }
        if (comparison === 'older') break;
        if (comparison === 'concurrent' || (comparison === 'equal' && local)) {
          if (incoming.store === 'lore' && !incoming.deleted && !local.deleted) {
            const remoteValue = await this.db.decodeRecord?.('lore', incoming.value) || incoming.value;
            const merged = reconcileWorld(local, incoming, await this.db.get('lore', incoming.id), remoteValue);
            if (merged) {
              await this.applyIncoming({ ...incoming, ...merged, clock: mergeClocks(local.clock, incoming.clock), hash: await contentHash(merged.value) }, expect);
              received++; this.onPending(); break;
            }
          }
          const id = `conflict:${key}:${[local.hash, incoming.hash].sort().map(hash => hash.slice(0, 16)).join(':')}`;
          if (!await this.db.get('syncConflicts', id)) {
            await this.db.put('syncConflicts', { id, type: 'database-record', store: incoming.store, recordId: incoming.id, local: { ...local, value: raw }, remote: incoming, deviceId: state.deviceId, createdAt: Date.now() });
            conflicts++;
          }
          break;
        }
        await this.applyIncoming(incoming, expect);
        received++;
        break;
        } catch (error) {
          if (error.code !== 'SYNC_RETRY' || attempt === 9) throw error;
        }
        }
      }
    await this.work;
    if (received || conflicts) await this.onChange({ received, conflicts });
    return { received, conflicts };
  }
  async applyIncoming(record, expect = {}) {
    await this.db.atomicWrite({
      [record.store]: record.deleted ? [] : [record.value],
      syncJournal: [{ id: keyOf(record.store, record.id), store: record.store, recordId: record.id, clock: record.clock, hash: record.hash, members: record.members, deleted: !!record.deleted, updatedAt: Date.now() }],
    }, { origin: 'sync', expect, deletes: record.deleted ? { [record.store]: [record.id] } : {} });
    await this.clearResolvedConflicts(record);
  }
  async clearResolvedConflicts(record) {
    let removed = 0;
    for (const conflict of await this.db.getAll('syncConflicts')) {
      if (conflict.store === record.store && conflict.recordId === record.id && compareClocks(record.clock, mergeClocks(conflict.local?.clock, conflict.remote?.clock)) === 'newer') { await this.db.delete('syncConflicts', conflict.id); removed++; }
    }
    return removed;
  }
  async resolveConflict(id, choice, mergedValue = null) {
    await this.work;
    const conflict = await this.db.get('syncConflicts', id);
    if (!conflict || conflict.locked) throw new Error('Конфликт недоступен.');
    const variant = choice === 'remote' ? conflict.remote : conflict.local;
    const clock = mergeClocks(conflict.local.clock, conflict.remote.clock);
    clock[this.deviceId] = (clock[this.deviceId] || 0) + 1;
    const value = mergedValue || variant.value;
    const decoded = await this.db.decodeRecord?.(conflict.store, value) || value;
    const record = { store: conflict.store, id: conflict.recordId, clock, hash: mergedValue ? await contentHash(value) : variant.hash, deleted: mergedValue ? false : !!variant.deleted, value,
      members: conflict.store === 'lore' && decoded && !decoded.locked ? await memberVersions(decoded, { ...conflict.local.members, ...conflict.remote.members }, this.deviceId) : undefined };
    await this.applyIncoming(record); await this.db.delete('syncConflicts', id);
    await this.onChange({ received: 1, conflicts: 0 });
    this.onPending();
  }
}
