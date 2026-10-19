import assert from 'node:assert/strict';
import test from 'node:test';
import { coreCanonicalJson, prepareCoreCommand } from './tenant-core-command.js';
import { CoreError } from './tenant-core-errors.js';

const descriptor = {
  commandId: '53547551-8190-419d-96ce-61a0be65b5d8',
  action: 'ORGANIZATION_UPDATE' as const,
  resourceType: 'ORGANIZATION' as const,
  resourceId: 'd30776d9-ccba-4cf4-a78f-0cae54d657b7',
  expectedRevision: '0',
  payload: { displayName: 'Care', defaults: { locale: 'th', timeZone: 'Asia/Bangkok' } },
};
test('Core wire contract: canonical JSON/digest คง semantic key order และผูก expected revision', () => {
  assert.equal(coreCanonicalJson({ z: 0, a: [1, 'ทดสอบ'] }), '{"a":[1,"ทดสอบ"],"z":0}');
  const first = prepareCoreCommand(descriptor);
  assert.equal(
    first.payloadDigest,
    'ee01c09873813a267482ae61add4dd35e7cf93de741a0828b81d962d74baac87',
  );
  assert.equal(
    prepareCoreCommand({
      ...descriptor,
      payload: { defaults: { timeZone: 'Asia/Bangkok', locale: 'th' }, displayName: 'Care' },
    }).payloadDigest,
    first.payloadDigest,
  );
  assert.notEqual(
    prepareCoreCommand({ ...descriptor, expectedRevision: '1' }).payloadDigest,
    first.payloadDigest,
  );
  assert.notEqual(
    prepareCoreCommand({ ...descriptor, payload: { displayName: 'care' } }).payloadDigest,
    first.payloadDigest,
  );
});
test('Core wire contract: revision ต้องเป็น decimal string ใน bigint range ไม่ coerce', () => {
  for (const expectedRevision of [0, -1, '00', '-1', '1e2', '9223372036854775808', null]) {
    assert.throws(
      () => prepareCoreCommand({ ...descriptor, expectedRevision }),
      (error: unknown) => error instanceof CoreError && error.status === 400,
    );
  }
  assert.equal(
    prepareCoreCommand({ ...descriptor, expectedRevision: '9223372036854775807' }).expectedRevision,
    '9223372036854775807',
  );
  assert.throws(() => prepareCoreCommand({ ...descriptor, resourceType: 'TEAM' }), CoreError);
  assert.throws(
    () => prepareCoreCommand({ ...descriptor, resourceType: 'TEAM', action: 'TEAM_RENAME' }),
    CoreError,
  );
  assert.equal(
    prepareCoreCommand({
      ...descriptor,
      resourceType: 'TEAM',
      action: 'TEAM_CREATE',
      expectedRevision: null,
    }).expectedRevision,
    null,
  );
});
test('Core wire contract: UUID canonical และรับเฉพาะ JSON values ที่ส่งข้าม API ได้', () => {
  assert.equal(
    prepareCoreCommand({ ...descriptor, commandId: descriptor.commandId.toUpperCase() }).commandId,
    descriptor.commandId,
  );
  assert.throws(() => prepareCoreCommand({ ...descriptor, commandId: 'not-a-uuid' }), CoreError);
  for (const value of [undefined, Infinity, NaN, new Date(), () => undefined])
    assert.throws(() => coreCanonicalJson(value), CoreError);
});
