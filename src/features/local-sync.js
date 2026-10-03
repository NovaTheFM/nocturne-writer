import { uid } from '../core/utils.js';
import { encryptJson, decryptJson } from '../core/crypto.js';
import { SYNC_PROTOCOL_VERSION, pairingNonce, pairingProof, verifyPairingProof } from '../core/sync-auth.js';

export { SYNC_PROTOCOL_VERSION };

export function createDeviceId() {
  try {
    const existing = localStorage.getItem('nocturne-sync-device-id');
    if (existing) return existing;
  } catch {}
  const id = uid('device');
  try { localStorage.setItem('nocturne-sync-device-id', id); } catch {}
  return id;
}

export function defaultDeviceName(runtime = {}) {
  if (runtime.isAndroid) return 'Android телефон';
  if (runtime.isCapacitor) return 'Мобильное устройство';
  return 'Компьютер';
}

export function publicDeviceId(deviceId = '') {
  let hash = 2166136261;
  for (const char of String(deviceId)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `nd-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeHostPort(host = '', port = '') {
  let raw = String(host || '').trim();
  let cleanPort = String(port || '').trim() || '8787';
  raw = raw.replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  if (raw.includes(':') && !raw.startsWith('[')) {
    const parts = raw.split(':');
    raw = parts[0];
    cleanPort = parts[1] || cleanPort;
  }
  return { host: raw || '127.0.0.1', port: cleanPort };
}

export function buildSyncUrl(host = '', port = '') {
  const clean = normalizeHostPort(host, port);
  return `ws://${clean.host}:${clean.port}`;
}

export function buildHttpBase(host = '', port = '') {
  const clean = normalizeHostPort(host, port);
  return `http://${clean.host}:${clean.port}`;
}

export class LocalSyncClient {
  constructor(app) {
    this.app = app;
    this.ws = null;
    this.status = 'offline';
    this.connectedDevice = null;
    this.pendingPings = new Map();
    this.connectAttempt = null;
    this.peers = new Map();
    this.incoming = Promise.resolve();
    this.sequence = 0;
  }

  setStatus(status, detail = '', stage = '') {
    this.status = status;
    this.app.state.sync.status = status;
    this.app.state.sync.statusDetail = detail;
    this.app.state.sync.diagnosticStage = stage;
    this.app.updateSyncStatusUi?.();
  }

  fail(stage, detail) {
    this.setStatus('error', `Этап ${stage}: ${detail}`, stage);
    if (this.connectAttempt?.reject) {
      this.connectAttempt.reject(new Error(`Этап ${stage}: ${detail}`));
      this.connectAttempt = null;
    }
  }

  connect({ host, port, token, trusted = false }) {
    this.disconnect(false);
    this.connection = { host, port, token, trusted };
    this.authenticated = false;
    this.pairChallenge = null;
    this.pairClientNonce = pairingNonce();
    this.manuallyDisconnected = false;
    const sequence = ++this.sequence;
    const url = buildSyncUrl(host, port);
    this.app.state.sync.host = host;
    this.app.state.sync.port = port || '8787';
    this.app.state.sync.token = token;
    this.setStatus('waiting', 'Этап ws open: открываю WebSocket...', 'ws open');

    return new Promise((resolve, reject) => {
      this.connectAttempt = { resolve, reject };
      let opened = false;
      this.ws = new WebSocket(url);

      const timeout = window.setTimeout(() => {
        if (this.connectAttempt && sequence === this.sequence) {
          this.fail(opened ? 'pair' : 'ws open', 'Сервер не ответил вовремя. Проверьте Wi‑Fi, адрес и код подключения.');
          this.disconnect(false);
        }
      }, 9000);

      this.ws.onopen = () => {
        opened = true;
        this.setStatus('waiting', 'Этап pair: проверяю pairing code...', 'pair');
      };

      this.ws.onmessage = (event) => {
        if (sequence !== this.sequence) return;
        try { if (JSON.parse(event.data)?.type === 'paired') window.clearTimeout(timeout); }
        catch { this.fail('protocol', 'Сервер прислал некорректный ответ.'); return; }
        this.handleMessage(event.data).catch(error => this.fail('protocol', error.message));
      };
      this.ws.onerror = () => {
        window.clearTimeout(timeout);
        if (this.status !== 'error') {
          this.fail(opened ? 'pair' : 'ws open', opened
            ? 'WebSocket открылся, но сервер вернул сетевую ошибку во время pairing.'
            : 'Ошибка WebSocket. Проверьте IP, порт, Wi-Fi, firewall и LAN HTTP/WS.');
        }
      };
      this.ws.onclose = () => {
        if (sequence !== this.sequence) return;
        window.clearTimeout(timeout);
        for (const ping of this.pendingPings.values()) {
          window.clearTimeout(ping.timeout);
          ping.reject(new Error('Соединение закрыто до pong.'));
        }
        this.pendingPings.clear();
        this.peers.clear();
        this.connectAttempt?.reject(new Error('Соединение закрыто.')); this.connectAttempt = null;
        if (this.status !== 'offline' && this.status !== 'error') {
          this.setStatus('offline', 'Соединение потеряно. Очередь изменений сохранена локально.', 'close');
        }
        if (!this.manuallyDisconnected && this.connection?.trusted) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.connect(this.connection).catch(() => {}), 2500);
        }
      };
    });
  }

  disconnect(updateStatus = true) {
    this.sequence++;
    this.manuallyDisconnected = updateStatus;
    clearTimeout(this.reconnectTimer);
    this.connectAttempt?.reject(new Error('Подключение отменено.')); this.connectAttempt = null;
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    this.ws = null;
    for (const ping of this.pendingPings.values()) {
      window.clearTimeout(ping.timeout);
      ping.reject(new Error('Соединение закрыто.'));
    }
    this.pendingPings.clear();
    this.peers.clear();
    if (updateStatus) this.setStatus('offline', 'Отключено.', 'offline');
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN && this.status === 'connected';
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  ping(timeoutMs = 2600) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket не открыт.'));
    }
    const id = `ping-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingPings.delete(id);
        reject(new Error('Pong не получен за время ожидания.'));
      }, timeoutMs);
      this.pendingPings.set(id, { resolve, reject, timeout });
      this.send({ type: 'ping', id, at: Date.now() });
    });
  }

  async verifyAfterPair(message) {
    this.peers = new Map((message.peers || []).map(peer => [peer.deviceId, peer]));
    this.connectedDevice = message.peer || message.server || null;
    this.setStatus('waiting', 'Этап ping/pong: проверяю обмен сообщениями...', 'ping/pong');
    try {
      await this.ping();
    } catch (error) {
      this.fail('ping/pong', error?.message || 'Сервер не ответил на ping.');
      return;
    }
    this.setStatus('connected', 'Связь установлена. Discovery, WebSocket, pair и ping/pong пройдены.', 'connected');
    await this.app.persistSyncDevice?.({ ...(message.peer || message.server || {}), trusted: true, autoReconnect: true, pairingStatus: 'paired' });
    if (!this.app.isMobileLayout?.()) this.app.renderSyncSurfaces?.({ preserveInputs: true });
    await this.app.flushSyncQueue?.();
    for (const queued of await this.app.db.getAll('syncQueue')) {
      if (queued.kind === 'database-state' && this.peers.has(queued.frame?.to)) this.send(queued.frame);
    }
    if (this.connectAttempt?.resolve) this.connectAttempt.resolve(message);
    this.connectAttempt = null;
  }

  async sendSecure(message, to) {
    const id = uid('sync-message');
    const frame = { type: 'relay', to, messageId: id, payload: await encryptJson(message, this.connection.token) };
    await this.app.db.put('syncQueue', { id, kind: 'database-state', frame, createdAt: Date.now() });
    this.send(frame);
  }

  async sendDatabaseState(state) {
    if (!this.isOpen() || !this.peers.size) return;
    for (const peer of this.peers.keys()) {
      for (let start = 0; start < state.records.length; start += 50) {
        await this.sendSecure({ type: 'database-state', state: { ...state, records: state.records.slice(start, start + 50) } }, peer);
      }
    }
  }

  async handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.fail('protocol', 'Сервер прислал некорректное JSON-сообщение.');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') throw new Error('Некорректный ответ сервера.');
    if (message.type === 'pair-challenge') {
      if (message.protocolVersion !== SYNC_PROTOCOL_VERSION || this.pairChallenge) throw new Error('Версия протокола локальной связи не совпадает.');
      this.pairChallenge = message.challenge;
      const clientNonce = this.pairClientNonce, deviceId = this.app.state.sync.deviceId;
      this.send({ type: 'pair', protocolVersion: SYNC_PROTOCOL_VERSION, clientNonce, deviceId,
        proof: await pairingProof(this.connection.token, 'client', message.challenge, clientNonce, deviceId),
        publicDeviceId: publicDeviceId(deviceId), deviceName: this.app.state.sync.deviceName,
        deviceType: this.app.runtime?.isAndroid ? 'phone' : 'computer', runtime: this.app.runtime?.platform || 'browser' });
      return;
    }
    if (!this.authenticated && !['paired', 'error'].includes(message.type)) throw new Error('Сервер ещё не подтвердил подключение.');
    if (message.type === 'pong') {
      const pending = this.pendingPings.get(message.id);
      if (pending) {
        window.clearTimeout(pending.timeout);
        this.pendingPings.delete(message.id);
        pending.resolve(message);
      }
      return;
    }
    if (message.type === 'paired') {
      if (!await verifyPairingProof(message.proof, this.connection.token, 'server', this.pairChallenge, this.pairClientNonce, this.app.state.sync.deviceId)) throw new Error('Сервер не подтвердил код подключения.');
      this.authenticated = true;
      await this.verifyAfterPair(message);
      return;
    }
    if (message.type === 'peer-joined') {
      this.peers.set(message.peer.deviceId, message.peer);
      this.connectedDevice = message.peer || null;
      await this.app.persistSyncDevice?.(message.peer || {});
      this.setStatus('connected', `${message.peer?.deviceName || 'Устройство'} подключено.`, 'connected');
      if (!this.app.isMobileLayout?.()) this.app.renderSyncSurfaces?.({ preserveInputs: true });
      await this.app.sendSyncProjectState?.();
      return;
    }
    if (message.type === 'peer-left') {
      this.peers.delete(message.peer?.deviceId);
      this.setStatus('connected', 'Ожидаю второе устройство. Изменения сохраняются локально.', 'connected');
      return;
    }
    if (message.type === 'relay-ack') {
      const queued = await this.app.db.get('syncQueue', message.messageId);
      if (queued?.frame?.to === message.from) await this.app.db.delete('syncQueue', message.messageId);
      return;
    }
    if (message.type === 'relay') {
      if (message.to !== this.app.state.sync.deviceId || !this.peers.has(message.from)) return;
      this.incoming = this.incoming.catch(() => {}).then(async () => {
        const decoded = await decryptJson(message.payload, this.connection.token);
        if (decoded.type !== 'database-state' || decoded.state.deviceId !== message.from) throw new Error('Отправитель сообщения не совпадает.');
        await this.app.flushOpenDocuments();
        await this.app.databaseSync.receiveState(decoded.state);
        this.send({ type: 'relay-ack', to: message.from, messageId: message.messageId });
      });
      await this.incoming;
      return;
    }
    if (message.type === 'project-state-request') {
      await this.app.sendSyncProjectState?.();
      return;
    }
    if (message.type === 'project-state') {
      await this.app.receiveSyncProjectState?.(message);
      return;
    }
    if (message.type === 'merge-accepted') {
      await this.app.receiveSyncMergeAccepted?.(message);
      return;
    }
    if (message.type === 'doc-patch') {
      await this.app.receiveSyncPatch?.(message.patch);
      return;
    }
    if (message.type === 'error') {
      this.fail(this.status === 'waiting' ? 'pair' : 'protocol', message.message || 'Ошибка локальной связи.');
    }
  }
}
