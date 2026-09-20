import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoBreakingChanges } from './cg5-openapi-breaking-check.mjs';

const base = {
  paths: {
    '/v1/contact': {
      get: {
        'x-dcontact-external': true,
        parameters: [{ name: 'contactId', in: 'path', required: true }],
        responses: { 200: {}, 429: {} },
      },
    },
  },
};

test('CG5 OpenAPI guard ยอมรับ additive response และ optional parameter', () => {
  const current = structuredClone(base);
  current.paths['/v1/contact'].get.parameters.push({
    name: 'include',
    in: 'query',
    required: false,
  });
  current.paths['/v1/contact'].get.responses['304'] = {};
  assert.doesNotThrow(() => assertNoBreakingChanges(base, current));
});

test('CG5 OpenAPI guard ปฏิเสธการลบ route หรือเพิ่ม required parameter', () => {
  assert.throws(() => assertNoBreakingChanges(base, { paths: {} }), /ลบ external path/);
  const current = structuredClone(base);
  current.paths['/v1/contact'].get.parameters.push({
    name: 'tenantId',
    in: 'query',
    required: true,
  });
  assert.throws(() => assertNoBreakingChanges(base, current), /เพิ่ม required parameter/);
});
