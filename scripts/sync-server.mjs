#!/usr/bin/env node
import { createServer } from 'node:http';
import { networkInterfaces, hostname } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import Bonjour from 'bonjour-service';

const PROTOCOL_VERSION = 1;
const port = Number(process.env.SYNC_PORT || 8787);
const token = String(process.env.SYNC_TOKEN || randomBytes(3).toString('hex')).toUpperCase();
const deviceName = String(process.env.NOCTURNE_SYNC_DEVICE_NAME || hostname() || 'Nocturne Desktop').slice(0, 80);
const deviceType = String(process.env.NOCTURNE_SYNC_DEVICE_TYPE || 'computer').slice(0, 40);
const privateDeviceId = process.env.NOCTURNE_SYNC_DEVICE_ID || randomBytes(16).toString('hex');
const publicDeviceId = `nd-${createHash('sha256').update(privateDeviceId).digest('hex').slice(0, 12)}`;
const serverStartedAt = Date.now();
const clients = new Map();

function localAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

function send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

function publicPeer(client) {
  return {
    publicDeviceId: client.publicDeviceId,
    deviceName: client.deviceName,
    deviceType: client.deviceType || client.runtime || 'browser',
    runtime: client.runtime,
    connectedAt: client.connectedAt,
    lastSeenAt: Date.now(),
  };
}

function pairedPeer(client) {
  return { ...publicPeer(client), deviceId: client.deviceId };
}

function discoveryPayload() {
  return {
    app: 'Nocturne Writer',
    service: 'nocturne-sync',
    protocolVersion: PROTOCOL_VERSION,
    publicDeviceId,
    deviceName,
    deviceType,
    pairingRequired: true,
    port,
    serverStartedAt,
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  if (status === 204) {
    res.end();
    return;
  }
  res.end(JSON.stringify(payload, null, 2));
}

function broadcast(sender, message) {
  for (const client of clients.values()) {
    if (client.ws !== sender && client.ws.readyState === 1) {
      send(client.ws, { ...message, from: message.from || clients.get(sender)?.deviceId });
    }
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${port}`}`);
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }
  if (url.pathname === '/health') {
    sendJson(res, 200, { ...discoveryPayload(), status: 'ok', role: 'in-memory-broker' });
    return;
  }
  if (url.pathname === '/discovery') {
    sendJson(res, 200, discoveryPayload());
    return;
  }
  if (url.pathname === '/peers' || url.pathname === '/status') {
    sendJson(res, 200, {
      ...discoveryPayload(),
      role: 'in-memory-broker',
      peers: [...clients.values()].map(publicPeer),
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Nocturne Writer LAN Sync broker. Use WebSocket with the pairing code shown in the terminal.');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  let paired = false;
  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      send(ws, { type: 'error', message: 'Некорректное JSON-сообщение.' });
      return;
    }
    if (!paired) {
      const version = Number(message.protocolVersion || 0);
      if (version !== PROTOCOL_VERSION) {
        send(ws, { type: 'error', message: 'Версия протокола локальной связи не совпадает.' });
        ws.close(1008, 'Invalid protocol version');
        return;
      }
      if (message.type !== 'pair' || String(message.token || '').toUpperCase() !== token) {
        send(ws, { type: 'error', message: 'Неверный pairing code.' });
        ws.close(1008, 'Invalid pairing token');
        return;
      }
      paired = true;
      const client = {
        ws,
        deviceId: String(message.deviceId || `device-${Date.now()}`),
        publicDeviceId: String(message.publicDeviceId || '').slice(0, 80),
        deviceName: String(message.deviceName || 'Устройство').slice(0, 80),
        deviceType: String(message.deviceType || message.runtime || 'browser').slice(0, 40),
        runtime: String(message.runtime || 'browser').slice(0, 40),
        ip: req.socket.remoteAddress,
        connectedAt: Date.now(),
      };
      clients.set(ws, client);
      const peers = [...clients.values()].filter((item) => item.ws !== ws).map(pairedPeer);
      send(ws, { type: 'paired', peer: peers[0] || null, peers, server: discoveryPayload() });
      broadcast(ws, { type: 'peer-joined', peer: pairedPeer(client), from: client.deviceId });
      console.log(`[sync] paired ${client.deviceName} (${client.publicDeviceId || client.deviceId}) from ${client.ip}`);
      return;
    }
    const sender = clients.get(ws);
    if (!sender) return;
    if (message.type === 'ping') {
      send(ws, { type: 'pong', id: message.id, at: Date.now() });
      return;
    }
    const allowed = new Set(['project-state-request', 'project-state', 'merge-accepted', 'doc-patch', 'presence']);
    if (!allowed.has(message.type)) {
      send(ws, { type: 'error', message: `Неподдерживаемый тип сообщения: ${message.type}` });
      return;
    }
    broadcast(ws, { ...message, from: sender.deviceId, deviceName: sender.deviceName });
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    clients.delete(ws);
    if (client) {
      broadcast(ws, { type: 'peer-left', peer: pairedPeer(client), from: client.deviceId });
      console.log(`[sync] disconnected ${client.deviceName} (${client.publicDeviceId || client.deviceId})`);
    }
  });
});

let bonjour = null;
let bonjourService = null;

function startBonjour() {
  try {
    bonjour = new Bonjour();
    bonjourService = bonjour.publish({
      name: `Nocturne Sync - ${deviceName}`,
      type: 'nocturne-sync',
      protocol: 'tcp',
      port,
      txt: {
        protocolVersion: String(PROTOCOL_VERSION),
        publicDeviceId,
        deviceName,
        deviceType,
        pairingRequired: 'true',
      },
    });
    console.log('[sync] mDNS advertising enabled: _nocturne-sync._tcp.local');
  } catch (error) {
    console.warn(`[sync] mDNS advertising unavailable: ${error?.message || error}`);
  }
}

function shutdown() {
  try { bonjourService?.stop?.(); } catch {}
  try { bonjour?.destroy?.(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1200).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(port, '0.0.0.0', () => {
  const addresses = localAddresses();
  console.log('Nocturne Writer LAN Sync broker');
  console.log(`Pairing code: ${token}`);
  console.log(`Port: ${port}`);
  console.log(`Public device: ${publicDeviceId}`);
  addresses.forEach((address) => console.log(`Phone URL: ws://${address}:${port}`));
  if (!addresses.length) console.log(`Local URL: ws://127.0.0.1:${port}`);
  console.log('Broker is in-memory only. Client IndexedDB stores queues, mappings, conflicts and revisions.');
  startBonjour();
});
