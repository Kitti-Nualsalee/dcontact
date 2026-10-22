import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { parseConfiguration } from './tenant-voice-configuration.js';

test('B4 canonical set normalization preserves idempotency across item order and rejects ambiguous payloads', () => {
  const envelope = {
    commandId: randomUUID(),
    expectedRevision: 1,
    reasonCode: 'CONFIG_CHANGE',
    reason: '  เตรียมทีม  ',
  };
  const skillIds = [randomUUID(), randomUUID()].sort();
  const first = parseConfiguration(
    { ...envelope, items: skillIds.map((skillId) => ({ skillId, minLevel: 3 })) },
    'requirements',
  );
  const reversed = parseConfiguration(
    {
      ...envelope,
      items: [...skillIds]
        .reverse()
        .map((skillId) => ({ skillId: skillId.toUpperCase(), minLevel: 3 })),
    },
    'requirements',
  );
  assert.deepEqual(first, reversed);
  assert.equal(first.reason, 'เตรียมทีม');
  for (const body of [
    { ...envelope, tenantId: randomUUID(), items: [] },
    { ...envelope, expectedRevision: 0, items: [] },
    { ...envelope, reasonCode: 'bad', items: [] },
    { ...envelope, reason: '\u0000', items: [] },
    { ...envelope, items: [{ skillId: skillIds[0], minLevel: 6 }] },
    {
      ...envelope,
      items: [
        { skillId: skillIds[0], minLevel: 1 },
        { skillId: skillIds[0], minLevel: 2 },
      ],
    },
    {
      ...envelope,
      items: Array.from({ length: 101 }, () => ({ skillId: randomUUID(), minLevel: 1 })),
    },
  ])
    assert.throws(() => parseConfiguration(body, 'requirements'));
  assert.throws(() => parseConfiguration(envelope, 'queue'));
  assert.throws(() => parseConfiguration({ ...envelope, queueId: randomUUID() }, 'binding'));
  assert.throws(() =>
    parseConfiguration(
      { ...envelope, items: [{ skillId: skillIds[0], minLevel: 1 }] },
      'agent-skills',
    ),
  );
});
