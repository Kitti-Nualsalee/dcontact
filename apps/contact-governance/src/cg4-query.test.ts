import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeQueueCursor, encodeQueueCursor } from './cg4-query.js';

/**
 * #179 decision gap: pure round-trip and fail-safe behaviour of the tenant-wide exception
 * queue's opaque cursor. `cg4PendingExceptionQueue` itself is proven against real Postgres
 * in cg4-query.integration.ts (sort order, cross-tenant isolation, filters, pagination).
 */

test('cursor round-trips exactly and is opaque (not a readable offset)', () => {
  const key = { tier: 'EMERGENCY' as const, expiresAt: '2026-09-15T00:00:00.000Z', seriesId: 'a' };
  const cursor = encodeQueueCursor(key);
  assert.doesNotMatch(cursor, /EMERGENCY|2026-09-15|^\d+$/);
  assert.deepEqual(decodeQueueCursor(cursor), key);
});

test('a malformed or tampered cursor falls back to undefined instead of throwing', () => {
  for (const bad of ['not-base64!!', Buffer.from('null').toString('base64url'), '', undefined]) {
    assert.equal(decodeQueueCursor(bad), undefined, String(bad));
  }
  const truncated = encodeQueueCursor({
    tier: 'HIGH',
    expiresAt: '2026-01-01T00:00:00.000Z',
    seriesId: 'x',
  }).slice(0, 5);
  assert.equal(decodeQueueCursor(truncated), undefined);
});
