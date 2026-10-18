import { t, ui, msg } from '../core/i18n.js';
export class ProjectBackups {
  constructor({ db, files, buildDump, enabled = () => true }) {
    Object.assign(this, { db, files, buildDump, enabled });
    this.running = null;
  }
  async create({ automatic = false } = {}) {
    if (automatic && !this.enabled()) return null;
    if (this.running) return this.running;
    this.running = this.write().finally(() => { this.running = null; });
    return this.running;
  }
  async write() {
    const dump = await this.buildDump();
    const createdAt = Date.now(), name = `nocturne-${new Date(createdAt).toISOString().replace(/:/g, '-')}.nocturnedump`;
    const data = JSON.stringify(dump), result = await this.files.writeBackup(data, name);
    const record = { id: `backup:${createdAt}`, createdAt, name, bytes: new TextEncoder().encode(data).length, external: !!result?.external, path: result?.path || '', ...(result?.external ? {} : { dump }) };
    await this.db.put('backups', record);
    const records = (await this.db.getAll('backups')).sort((a, b) => b.createdAt - a.createdAt);
    for (const old of records.slice(20)) await this.db.delete('backups', old.id);
    return record;
  }
  async read(record) {
    if (record.locked) throw new Error(t('Введите мастер-пароль, чтобы открыть копию.'));
    return record.dump || JSON.parse(await this.files.readBackup(record.name));
  }
}
