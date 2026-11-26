/**
 * E1.14 (#488): contract test of postMessage v1 — the JSON Schema (`schema/v1.json`) and the TypeScript types
 * must match in both directions, and `parseHostMessage()` must decide the same as the schema
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

/** every field of a type — `satisfies Record<keyof T, true>` makes compile fail if the type has a field that is not listed here */
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

/** a message with only the required fields — if the type requires more than this, compile fails; if the schema requires more, validation fails */
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

test('TypeScript type fields match the schema properties for every type (both directions)', () => {
  for (const [name, fields] of Object.entries(fieldsOf)) {
    const properties = Object.keys(schema.$defs[name].properties).sort();
    assert.deepEqual(Object.keys(fields).sort(), properties, name);
  }
  // every type in the schema must have a matching TypeScript type
  const union = [...schema.$defs.dphoneToHost.oneOf, ...schema.$defs.hostToDphone.oneOf].map(
    (ref: { $ref: string }) => ref.$ref.replace('#/$defs/', ''),
  );
  assert.deepEqual(union.sort(), Object.keys(fieldsOf).sort());
});

test('required fields: a message with only the type required fields passes the schema and the schema required does not exceed that', () => {
  for (const message of minimal) {
    assert.equal(validate(message), true, `${message.type}: ${ajv.errorsText(validate.errors)}`);
    assert.deepEqual(
      [...schema.$defs[message.type].required].sort(),
      Object.keys(message).sort(),
      message.type,
    );
  }
});

test('every message must have v:1 — any other v fails the schema', () => {
  for (const message of minimal) {
    assert.equal(validate({ ...message, v: 2 }), false, message.type);
  }
});

test('v1 is additive only: an unknown field still passes the schema (the receiver ignores it)', () => {
  for (const message of minimal) {
    assert.equal(validate({ ...message, futureField: 'x' }), true, message.type);
  }
});

const hostCases: [string, unknown][] = [
  ['normal call', { v: 1, type: 'dphone.call', requestId: 'a1', number: '081-234-5678' }],
  [
    'call + contactId',
    { v: 1, type: 'dphone.call', requestId: 'a2', number: '+6621234567', contactId: 'c-1' },
  ],
  ['call without requestId', { v: 1, type: 'dphone.call', number: '0812345678' }],
  [
    'call with letters in the number',
    { v: 1, type: 'dphone.call', requestId: 'a3', number: 'tel:0812' },
  ],
  [
    'call with an overlong number',
    { v: 1, type: 'dphone.call', requestId: 'a4', number: '1'.repeat(40) },
  ],
  [
    'call with a malformed contactId',
    { v: 1, type: 'dphone.call', requestId: 'a5', number: '0812345678', contactId: 'a b' },
  ],
  ['normal ack', { v: 1, type: 'dphone.activity.ack', interactionId: 'i-1' }],
  ['ack without interactionId', { v: 1, type: 'dphone.activity.ack' }],
  ['malformed requestId', { v: 1, type: 'dphone.call', requestId: '<x>', number: '0812345678' }],
];

test('parseHostMessage decides the same as the schema for messages from the host', () => {
  const hostSchema = validateDef('hostToDphone');
  for (const [name, data] of hostCases) {
    const parsed = parseHostMessage(data);
    assert.equal(parsed.kind === 'message', hostSchema(data), name);
    if (parsed.kind === 'message') assert.equal(hostSchema(parsed.message), true, name);
  }
});

test('parseHostMessage: unsupported v → unsupported_version (returns requestId); unknown type/not a dphone type → ignore', () => {
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

test('parseHostMessage copies only known fields — extra fields from the host are not forwarded', () => {
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
