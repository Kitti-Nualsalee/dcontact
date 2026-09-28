import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbedOriginApiError } from './dphone-embedding/api.js';
import { apiErrorKey, checkOriginInput, hostSnippet } from './dphone-embedding/model.js';

test('ตรวจ origin ทันทีด้วยกติกาเดียวกับ API', () => {
  assert.equal(checkOriginInput('  ', { dev: false }), null);
  assert.deepEqual(checkOriginInput('HTTPS://CRM.example.test:443', { dev: false }), {
    ok: true,
    origin: 'https://crm.example.test',
  });
  assert.deepEqual(checkOriginInput('https://crm.example.test/app', { dev: false }), {
    ok: false,
    messageKey: 'dphoneEmbedding.rejections.PATH_QUERY_FRAGMENT',
  });
  assert.equal(checkOriginInput('http://localhost:4000', { dev: false })?.ok, false);
  assert.equal(checkOriginInput('http://localhost:4000', { dev: true })?.ok, true);
});

test('error ของ API → key ของข้อความ', () => {
  assert.equal(
    apiErrorKey(new EmbedOriginApiError(400, 'VALIDATION_FAILED', 'origin', 'WILDCARD')),
    'dphoneEmbedding.rejections.WILDCARD',
  );
  assert.equal(
    apiErrorKey(new EmbedOriginApiError(409, 'EMBED_ORIGIN_LIMIT_REACHED')),
    'dphoneEmbedding.errors.EMBED_ORIGIN_LIMIT_REACHED',
  );
  assert.equal(
    apiErrorKey(new EmbedOriginApiError(403, undefined)),
    'dphoneEmbedding.errors.FORBIDDEN',
  );
  assert.equal(apiErrorKey(new EmbedOriginApiError(500, 'X')), 'dphoneEmbedding.errors.UNKNOWN');
});

test('snippet มี iframe ของ tenant, allow ไมค์, sandbox ที่มี allow-popups และ frame-src ของ host', () => {
  const snippet = hostSnippet({ embedBaseUrl: 'https://api.dcontact.test/', tenantAlias: 'demo' });
  assert.match(snippet, /src="https:\/\/api\.dcontact\.test\/dphone\/embed\?tenant=demo"/);
  assert.match(snippet, /allow="microphone; autoplay"/);
  assert.match(snippet, /allow-popups/);
  assert.match(snippet, /frame-src https:\/\/api\.dcontact\.test/);
});
