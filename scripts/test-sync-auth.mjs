import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pairingNonce, pairingProof, verifyPairingProof } from '../src/core/sync-auth.js';

test('pairing proofs cannot be replayed on another connection or reflected as a server proof', async () => {
  const token = '0123456789ABCDEF0123456789ABCDEF', challenge = pairingNonce(), clientNonce = pairingNonce();
  const proof = await pairingProof(token, 'client', challenge, clientNonce, 'device-a');
  assert.equal(await verifyPairingProof(proof, token.toLowerCase(), 'client', challenge, clientNonce, 'device-a'), true);
  assert.equal(await verifyPairingProof(proof, token, 'server', challenge, clientNonce, 'device-a'), false);
  assert.equal(await verifyPairingProof(proof, token, 'client', pairingNonce(), clientNonce, 'device-a'), false);
  assert.equal(await verifyPairingProof(proof, token, 'client', challenge, pairingNonce(), 'device-a'), false);
  assert.equal(await verifyPairingProof(proof, token, 'client', challenge, clientNonce, 'device-b'), false);
  assert.equal(await verifyPairingProof(proof, 'WRONG-TOKEN', 'client', challenge, clientNonce, 'device-a'), false);
  assert.equal(await verifyPairingProof(null, token, 'client', challenge, clientNonce, 'device-a'), false);
  assert.equal(await verifyPairingProof('invalid', token, 'client', challenge, clientNonce, 'device-a'), false);
});

test('invalid pairing input fails before computing a proof', async () => {
  const challenge = pairingNonce(), nonce = pairingNonce();
  for (const token of ['', null, '  ']) await assert.rejects(pairingProof(token, 'client', challenge, nonce, 'device'));
  for (const args of [['other', challenge, nonce, 'device'], ['client', null, nonce, 'device'], ['client', challenge, '', 'device'], ['client', challenge, nonce, '<invalid>'], ['client', challenge, nonce, null]]) await assert.rejects(pairingProof('secret', ...args));
});
