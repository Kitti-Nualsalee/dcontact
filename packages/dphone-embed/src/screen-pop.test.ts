import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  effectiveScreenPopLevel,
  projectScreenPop,
  SCREEN_POP_REASON,
  type ScreenPopLevel,
  type ScreenPopSource,
} from './index.js';

const schema = JSON.parse(readFileSync(new URL('../schema/v1.json', import.meta.url), 'utf8'));
const validate = new Ajv2020.default({ strict: true }).compile(schema);

/** source with every field populated — the projection must select only what the level allows */
const source: ScreenPopSource & Record<string, unknown> = {
  interactionId: 'int-1',
  contactId: 'contact-1',
  externalId: 'CIF-0001',
  direction: 'INBOUND',
  queue: { id: 'queue-service', name: 'Customer service' },
  callState: 'RINGING',
  ani: '0812345678',
  dnis: '021234567',
  displayName: 'Test Customer',
  customFields: { tier: 'gold', segment: 'retail', secretNote: 'do not send' },
  // data that no level sends
  email: 'x@example.test',
  recordingUrl: 'https://rec.example.test/1.wav',
  transcript: 'hello',
};

const decision = { policyVersion: 'cg-2026.09', decisionId: 'dec-1' };
const common = ['decisionId', 'interactionId', 'level', 'policyVersion', 'requestId', 'type', 'v'];
const ids = ['callState', 'contactId', 'direction', 'externalId', 'queue'];
const contact = ['ani', 'displayName', 'dnis'];

const expected: Record<ScreenPopLevel, string[]> = {
  interaction: common,
  ids: [...common, ...ids],
  contact: [...common, ...ids, ...contact],
  custom: [...common, ...ids, ...contact, 'fields'],
};

test('payload has only the fields of the set level — no extra fields, and it passes the schema', () => {
  for (const level of Object.keys(expected) as ScreenPopLevel[]) {
    const message = projectScreenPop({
      requestId: 'r1',
      source,
      level,
      decision,
      customFields: ['tier'],
    });
    assert.deepEqual(Object.keys(message).sort(), [...expected[level]].sort(), level);
    assert.equal(validate(message), true, level);
    const json = JSON.stringify(message);
    for (const leaked of ['x@example.test', 'rec.example.test', 'hello', 'do not send']) {
      assert.equal(json.includes(leaked), false, `${level} leaked ${leaked}`);
    }
  }
});

test('custom: sends only the fields the origin chose and that have values', () => {
  const message = projectScreenPop({
    requestId: 'r1',
    source,
    level: 'custom',
    decision,
    customFields: ['tier', 'missing', 'toString'],
  });
  assert.deepEqual(message.fields, { tier: 'gold' });
});

test('level ids has no ANI even if the contact is still unidentified; ANI is sent from level contact up', () => {
  const unknown = { ...source, contactId: null, externalId: null, displayName: null };
  const idsMessage = projectScreenPop({ requestId: 'r', source: unknown, level: 'ids', decision });
  assert.equal('ani' in idsMessage, false);
  assert.equal('contactId' in idsMessage, false);
  const contactMessage = projectScreenPop({
    requestId: 'r',
    source: unknown,
    level: 'contact',
    decision,
  });
  assert.equal(contactMessage.ani, '0812345678');
});

test('level lowering: off = do not send; no VIEW scope → interaction; restriction/objection → at most ids', () => {
  const ok = { teamSegmentView: true, restricted: false };
  assert.equal(effectiveScreenPopLevel('off', ok), null);
  assert.equal(effectiveScreenPopLevel('off', { teamSegmentView: false, restricted: true }), null);
  for (const setting of ['ids', 'contact', 'custom'] as const) {
    assert.deepEqual(effectiveScreenPopLevel(setting, ok), { level: setting });
    assert.deepEqual(
      effectiveScreenPopLevel(setting, { teamSegmentView: false, restricted: false }),
      {
        level: 'interaction',
        reasonCode: SCREEN_POP_REASON.TEAM_SEGMENT_NOT_ALLOWED,
      },
    );
    assert.deepEqual(
      effectiveScreenPopLevel(setting, { teamSegmentView: false, restricted: true }),
      {
        level: 'interaction',
        reasonCode: SCREEN_POP_REASON.TEAM_SEGMENT_NOT_ALLOWED,
      },
    );
  }
  assert.deepEqual(effectiveScreenPopLevel('ids', { teamSegmentView: true, restricted: true }), {
    level: 'ids',
  });
  for (const setting of ['contact', 'custom'] as const) {
    assert.deepEqual(
      effectiveScreenPopLevel(setting, { teamSegmentView: true, restricted: true }),
      {
        level: 'ids',
        reasonCode: SCREEN_POP_REASON.CONTACT_RESTRICTED,
      },
    );
  }
});

test('payload that was lowered attaches reasonCode, policyVersion and decisionId', () => {
  const effective = effectiveScreenPopLevel('custom', {
    teamSegmentView: false,
    restricted: false,
  })!;
  const message = projectScreenPop({ requestId: 'r', source, ...effective, decision });
  assert.deepEqual(message, {
    v: 1,
    type: 'dphone.screenpop',
    requestId: 'r',
    level: 'interaction',
    interactionId: 'int-1',
    reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED',
    policyVersion: 'cg-2026.09',
    decisionId: 'dec-1',
  });
});
