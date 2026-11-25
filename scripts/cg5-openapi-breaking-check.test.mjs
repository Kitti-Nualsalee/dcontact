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

test('CG5 OpenAPI guard accepts an additive response and an optional parameter', () => {
  const current = structuredClone(base);
  current.paths['/v1/contact'].get.parameters.push({
    name: 'include',
    in: 'query',
    required: false,
  });
  current.paths['/v1/contact'].get.responses['304'] = {};
  assert.doesNotThrow(() => assertNoBreakingChanges(base, current));
});

test('CG5 OpenAPI guard rejects removing a route or adding a required parameter', () => {
  assert.throws(() => assertNoBreakingChanges(base, { paths: {} }), /removed external path/);
  const current = structuredClone(base);
  current.paths['/v1/contact'].get.parameters.push({
    name: 'tenantId',
    in: 'query',
    required: true,
  });
  assert.throws(() => assertNoBreakingChanges(base, current), /added required parameter/);
});
