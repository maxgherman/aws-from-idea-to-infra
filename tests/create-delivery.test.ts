import assert from 'node:assert/strict';
import test from 'node:test';
import { decideDelivery } from '../lambda/create-delivery/index';

const assetId = '307d0b55-05d1-4c0f-a0fb-4c3e1083e3df';
const ownerId = 'owner-1';

test('does not reveal a missing asset or another owner asset', () => {
  assert.deepEqual(decideDelivery(undefined, ownerId, assetId), { status: 'not-found' });
  assert.deepEqual(
    decideDelivery({ ownerId: 'owner-2', status: 'ready' }, ownerId, assetId),
    { status: 'not-found' },
  );
});

test('does not deliver an asset before processing is ready', () => {
  assert.deepEqual(
    decideDelivery({ ownerId, status: 'processing' }, ownerId, assetId),
    { status: 'not-ready' },
  );
});

test('returns only the ready asset deterministic output key', () => {
  const outputKey = `processed/assets/${assetId}.png`;
  assert.deepEqual(
    decideDelivery({ ownerId, status: 'ready', outputKey }, ownerId, assetId),
    { status: 'ready', outputKey },
  );
});

test('rejects a ready record that points outside its own processed output', () => {
  assert.throws(
    () => decideDelivery({
      ownerId,
      status: 'ready',
      outputKey: 'uploads/originals/private.png',
    }, ownerId, assetId),
    /Unexpected output key/,
  );
});
