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

/** source ที่มีข้อมูลครบทุก field — projection ต้องคัดเฉพาะของระดับ */
const source: ScreenPopSource & Record<string, unknown> = {
  interactionId: 'int-1',
  contactId: 'contact-1',
  externalId: 'CIF-0001',
  direction: 'INBOUND',
  queue: { id: 'queue-service', name: 'บริการลูกค้า' },
  callState: 'RINGING',
  ani: '0812345678',
  dnis: '021234567',
  displayName: 'ลูกค้า ทดสอบ',
  customFields: { tier: 'gold', segment: 'retail', secretNote: 'ห้ามส่ง' },
  // ข้อมูลที่ไม่มีระดับใดส่ง
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

test('payload มีเฉพาะ field ของระดับที่ตั้ง — ไม่มี field เกิน และผ่าน schema', () => {
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
    for (const leaked of ['x@example.test', 'rec.example.test', 'hello', 'ห้ามส่ง']) {
      assert.equal(json.includes(leaked), false, `${level} รั่ว ${leaked}`);
    }
  }
});

test('custom: ส่งเฉพาะ field ที่ origin เลือกและมีค่า', () => {
  const message = projectScreenPop({
    requestId: 'r1',
    source,
    level: 'custom',
    decision,
    customFields: ['tier', 'missing', 'toString'],
  });
  assert.deepEqual(message.fields, { tier: 'gold' });
});

test('ระดับ ids ไม่มี ANI แม้ยังระบุ contact ไม่ได้; contact ขึ้นไปจึงส่ง ANI', () => {
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

test('ลดระดับ: ปิด = ไม่ส่ง; ไม่มี scope VIEW → interaction; restriction/objection → ไม่เกิน ids', () => {
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

test('payload ที่ถูกลดระดับแนบ reasonCode, policyVersion และ decisionId', () => {
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
