import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLineCanonicalRequest,
  buildLineCanonicalRequestFrom,
  LINE_FIXTURE_CONTENT_SOURCE,
  lineContentDigest,
} from './line-push-request.js';

test('#567 canonical request จากแหล่งเนื้อหาให้ผลเท่ากับ fixture เดิมทุก byte', async () => {
  const fingerprint = 'a'.repeat(64);
  const resolved = await LINE_FIXTURE_CONTENT_SOURCE.resolve(
    't',
    'fixture:service-notification/v1',
  );
  assert.deepEqual(
    buildLineCanonicalRequestFrom(resolved, fingerprint),
    buildLineCanonicalRequest({
      contentRef: 'fixture:service-notification/v1',
      recipientFingerprint: fingerprint,
    }),
  );
  assert.equal(resolved.gateDigest, lineContentDigest('fixture:service-notification/v1'));
});
