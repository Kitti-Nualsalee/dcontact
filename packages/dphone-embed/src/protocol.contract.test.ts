/**
 * E1.14 (#488): contract test ของ postMessage v1 — JSON Schema (`schema/v1.json`) กับ TypeScript types
 * ต้องตรงกันทั้งสองทาง และ `parseHostMessage()` ต้องตัดสินตรงกับ schema
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  parseHostMessage,
  type ActivityAckMessage,
  type ActivityMessage,
  type CallRequestMessage,
  type CallResultMessage,
  type DphoneErrorMessage,
  type DphoneReadyMessage,
  type DphoneToHostMessage,
  type HostToDphoneMessage,
  type ScreenPopMessage,
} from './index.js';

const schema = JSON.parse(readFileSync(new URL('../schema/v1.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020.default({ strict: true, allErrors: true });
const validate = ajv.compile(schema);
const validateDef = (name: string) => ajv.getSchema(`${schema.$id}#/$defs/${name}`)!;

/** ทุก field ของ type — `satisfies Record<keyof T, true>` ทำให้ compile ไม่ผ่านถ้า type มี field ที่ไม่อยู่ในนี้ */
const fieldsOf = {
  'dphone.ready': {
    v: true,
    type: true,
    capabilities: true,
    screenPopLevel: true,
  } satisfies Record<keyof DphoneReadyMessage, true>,
  'dphone.screenpop': {
    v: true,
    type: true,
    requestId: true,
    level: true,
    interactionId: true,
    reasonCode: true,
    policyVersion: true,
    decisionId: true,
    contactId: true,
    externalId: true,
    direction: true,
    queue: true,
    callState: true,
    ani: true,
    dnis: true,
    displayName: true,
    fields: true,
  } satisfies Record<keyof ScreenPopMessage, true>,
  'dphone.call.result': {
    v: true,
    type: true,
    requestId: true,
    status: true,
    blocked: true,
    reasonCode: true,
    retryAt: true,
    decisionId: true,
  } satisfies Record<keyof CallResultMessage, true>,
  'dphone.activity': {
    v: true,
    type: true,
    requestId: true,
    interactionId: true,
    contactId: true,
    direction: true,
    startedAt: true,
    endedAt: true,
    durationSeconds: true,
    disposition: true,
    wrapUpCode: true,
    queue: true,
  } satisfies Record<keyof ActivityMessage, true>,
  'dphone.error': {
    v: true,
    type: true,
    requestId: true,
    code: true,
    supportedVersions: true,
  } satisfies Record<keyof DphoneErrorMessage, true>,
  'dphone.call': {
    v: true,
    type: true,
    requestId: true,
    number: true,
    contactId: true,
  } satisfies Record<keyof CallRequestMessage, true>,
  'dphone.activity.ack': {
    v: true,
    type: true,
    interactionId: true,
    requestId: true,
  } satisfies Record<keyof ActivityAckMessage, true>,
};

/** ข้อความที่มีเฉพาะ field บังคับ — ถ้า type บังคับมากกว่านี้ compile ไม่ผ่าน; ถ้า schema บังคับมากกว่า validate ไม่ผ่าน */
const minimal: (DphoneToHostMessage | HostToDphoneMessage)[] = [
  {
    v: 1,
    type: 'dphone.ready',
    capabilities: { screenPop: false, clickToCall: true, activity: true },
    screenPopLevel: 'off',
  },
  {
    v: 1,
    type: 'dphone.screenpop',
    requestId: 'r1',
    level: 'interaction',
    interactionId: 'i1',
    policyVersion: 'p1',
    decisionId: 'd1',
  },
  { v: 1, type: 'dphone.call.result', requestId: 'r2', status: 'prefilled', blocked: false },
  {
    v: 1,
    type: 'dphone.activity',
    requestId: 'r3',
    interactionId: 'i2',
    direction: 'INBOUND',
    startedAt: '2026-09-28T10:00:00.000Z',
    endedAt: '2026-09-28T10:03:00.000Z',
    durationSeconds: 180,
  },
  { v: 1, type: 'dphone.error', code: 'unsupported_version', supportedVersions: [1] },
  { v: 1, type: 'dphone.call', requestId: 'r4', number: '+66812345678' },
  { v: 1, type: 'dphone.activity.ack', interactionId: 'i2' },
];

test('field ของ TypeScript type ตรงกับ properties ของ schema ทุก type (ทั้งสองทาง)', () => {
  for (const [name, fields] of Object.entries(fieldsOf)) {
    const properties = Object.keys(schema.$defs[name].properties).sort();
    assert.deepEqual(Object.keys(fields).sort(), properties, name);
  }
  // ทุก type ใน schema ต้องมี TypeScript type คู่กัน
  const union = [...schema.$defs.dphoneToHost.oneOf, ...schema.$defs.hostToDphone.oneOf].map(
    (ref: { $ref: string }) => ref.$ref.replace('#/$defs/', ''),
  );
  assert.deepEqual(union.sort(), Object.keys(fieldsOf).sort());
});

test('field บังคับ: ข้อความที่มีแค่ field บังคับของ type ผ่าน schema และ required ของ schema ไม่เกินนั้น', () => {
  for (const message of minimal) {
    assert.equal(validate(message), true, `${message.type}: ${ajv.errorsText(validate.errors)}`);
    assert.deepEqual(
      [...schema.$defs[message.type].required].sort(),
      Object.keys(message).sort(),
      message.type,
    );
  }
});

test('ทุกข้อความต้องมี v:1 — v อื่นไม่ผ่าน schema', () => {
  for (const message of minimal) {
    assert.equal(validate({ ...message, v: 2 }), false, message.type);
  }
});

test('v1 เพิ่มได้อย่างเดียว: field ที่ไม่รู้จักยังผ่าน schema (ฝั่งรับไม่สนใจ)', () => {
  for (const message of minimal) {
    assert.equal(validate({ ...message, futureField: 'x' }), true, message.type);
  }
});

const hostCases: [string, unknown][] = [
  ['call ปกติ', { v: 1, type: 'dphone.call', requestId: 'a1', number: '081-234-5678' }],
  [
    'call + contactId',
    { v: 1, type: 'dphone.call', requestId: 'a2', number: '+6621234567', contactId: 'c-1' },
  ],
  ['call ไม่มี requestId', { v: 1, type: 'dphone.call', number: '0812345678' }],
  ['call เบอร์มีตัวอักษร', { v: 1, type: 'dphone.call', requestId: 'a3', number: 'tel:0812' }],
  ['call เบอร์ยาวเกิน', { v: 1, type: 'dphone.call', requestId: 'a4', number: '1'.repeat(40) }],
  [
    'call contactId ผิดรูป',
    { v: 1, type: 'dphone.call', requestId: 'a5', number: '0812345678', contactId: 'a b' },
  ],
  ['ack ปกติ', { v: 1, type: 'dphone.activity.ack', interactionId: 'i-1' }],
  ['ack ไม่มี interactionId', { v: 1, type: 'dphone.activity.ack' }],
  ['requestId ผิดรูป', { v: 1, type: 'dphone.call', requestId: '<x>', number: '0812345678' }],
];

test('parseHostMessage ตัดสินตรงกับ schema ของข้อความจาก host', () => {
  const hostSchema = validateDef('hostToDphone');
  for (const [name, data] of hostCases) {
    const parsed = parseHostMessage(data);
    assert.equal(parsed.kind === 'message', hostSchema(data), name);
    if (parsed.kind === 'message') assert.equal(hostSchema(parsed.message), true, name);
  }
});

test('parseHostMessage: v ไม่รองรับ → unsupported_version (คืน requestId); type ที่ไม่รู้จัก/ไม่ใช่ของ dphone → ignore', () => {
  assert.deepEqual(
    parseHostMessage({ v: 2, type: 'dphone.call', requestId: 'x1', number: '0812' }),
    {
      kind: 'error',
      code: 'unsupported_version',
      requestId: 'x1',
    },
  );
  assert.deepEqual(parseHostMessage({ type: 'dphone.call' }), {
    kind: 'error',
    code: 'unsupported_version',
    requestId: undefined,
  });
  assert.deepEqual(parseHostMessage({ v: 1, type: 'dphone.future', requestId: 'x' }), {
    kind: 'ignore',
  });
  assert.deepEqual(parseHostMessage({ v: 1, type: 'crm.something' }), { kind: 'ignore' });
  assert.deepEqual(parseHostMessage('dphone.call'), { kind: 'ignore' });
  assert.deepEqual(parseHostMessage(null), { kind: 'ignore' });
});

test('parseHostMessage คัดลอกเฉพาะ field ที่รู้จัก — field เกินจาก host ไม่ถูกส่งต่อ', () => {
  const parsed = parseHostMessage({
    v: 1,
    type: 'dphone.call',
    requestId: 'a1',
    number: '0812345678',
    autoDial: true,
    __proto__: { polluted: true },
  });
  assert.equal(parsed.kind, 'message');
  if (parsed.kind === 'message') {
    assert.deepEqual(Object.keys(parsed.message).sort(), ['number', 'requestId', 'type', 'v']);
  }
});
