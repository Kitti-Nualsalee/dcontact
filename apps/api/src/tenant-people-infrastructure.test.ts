import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionPermit } from './tenant-people-infrastructure.js';

const node = {
  telephonyNodeId: 'synthetic-node',
  releaseDigest: 'a'.repeat(64),
  dialplanDigest: 'b'.repeat(64),
  extensions: ['1104'],
};
const entry = {
  ref: '1104',
  telephonyNodeId: node.telephonyNodeId,
  releaseDigest: node.releaseDigest,
  dialplanDigest: node.dialplanDigest,
};
test('extension requires approved pool metadata and a matching configured node/release/dialplan', () => {
  assert.deepEqual(extensionPermit([entry], 3, '1104', [node]), { ...entry, policyRevision: 3 });
  for (const pool of [
    ['1104'],
    [],
    [{ ...entry, telephonyNodeId: 'foreign' }],
    [{ ...entry, releaseDigest: 'c'.repeat(64) }],
    [{ ...entry, dialplanDigest: 'c'.repeat(64) }],
    [{ ...entry, password: 'forbidden' }],
  ])
    assert.equal(extensionPermit(pool, 3, '1104', [node]), null);
  assert.equal(extensionPermit([entry], 3, '1104', []), null);
  assert.equal(extensionPermit([entry], 3, '1104', [{ ...node, extensions: [] }]), null);
});
