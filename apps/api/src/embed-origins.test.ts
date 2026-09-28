import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEmbedOrigin } from '@d-contact/shared';
import { embedShellHeaders, embedShellHtml } from './embed-origins-api.js';

test('E1.11: normalize — รับ https exact origin, ตัด default port, ตัวพิมพ์เล็ก', () => {
  const accepted: Array<[string, string]> = [
    ['https://crm.example.test', 'https://crm.example.test'],
    ['https://CRM.Example.Test/', 'https://crm.example.test'],
    ['HTTPS://crm.example.test:443', 'https://crm.example.test'],
    ['https://crm.example.test:8443', 'https://crm.example.test:8443'],
    [
      '  https://xn--12cl1ck0bl6hdu9iyb9bp.example.test  ',
      'https://xn--12cl1ck0bl6hdu9iyb9bp.example.test',
    ],
  ];
  for (const [input, origin] of accepted) {
    assert.deepEqual(normalizeEmbedOrigin(input), { ok: true, origin }, input);
  }
});

test('E1.11: normalize — ปฏิเสธ path/query/fragment/userinfo/wildcard/IP/scheme อื่น/origin ของเรา', () => {
  const rejected: Array<[string, string]> = [
    ['crm.example.test', 'INVALID_URL'],
    ['', 'INVALID_URL'],
    ['https://', 'INVALID_URL'],
    ['http://crm.example.test', 'SCHEME_NOT_ALLOWED'],
    ['ftp://crm.example.test', 'SCHEME_NOT_ALLOWED'],
    ['javascript://crm.example.test', 'SCHEME_NOT_ALLOWED'],
    ['https://*.example.test', 'WILDCARD'],
    ['*', 'WILDCARD'],
    ['https://user:pass@crm.example.test', 'USERINFO'],
    ['https://user@crm.example.test', 'USERINFO'],
    ['https://crm.example.test/app', 'PATH_QUERY_FRAGMENT'],
    ['https://crm.example.test/?x=1', 'PATH_QUERY_FRAGMENT'],
    ['https://crm.example.test#frag', 'PATH_QUERY_FRAGMENT'],
    ['https://203.0.113.10', 'IP_ADDRESS'],
    ['https://[2001:db8::1]', 'IP_ADDRESS'],
    ['https://localhost:3000', 'LOCALHOST_NOT_ALLOWED'],
    ['http://localhost:3000', 'LOCALHOST_NOT_ALLOWED'],
  ];
  for (const [input, reason] of rejected) {
    assert.deepEqual(normalizeEmbedOrigin(input), { ok: false, reason }, input);
  }
  assert.deepEqual(
    normalizeEmbedOrigin('https://workspace.dcontact.test', {
      reservedOrigins: ['https://WORKSPACE.dcontact.test'],
    }),
    { ok: false, reason: 'RESERVED_ORIGIN' },
  );
});

test('E1.11: localhost / 127.0.0.1 ได้เฉพาะ dev', () => {
  for (const input of ['http://localhost:4000', 'http://127.0.0.1:8080', 'https://localhost']) {
    assert.equal(normalizeEmbedOrigin(input, { allowLocalhost: true }).ok, true, input);
  }
  assert.deepEqual(normalizeEmbedOrigin('http://10.0.0.5', { allowLocalhost: true }), {
    ok: false,
    reason: 'SCHEME_NOT_ALLOWED',
  });
});

test('E1.11: shell — ไม่มี origin = frame-ancestors none และไม่โหลด script; มี = allowlist ชุดเดียวกับ JSON', () => {
  const options = { scriptUrl: 'https://workspace.dcontact.test/embed/dphone-embed.js' };
  const closed = embedShellHeaders(null, options, 'n1');
  assert.match(closed['content-security-policy']!, /frame-ancestors 'none'/);
  assert.equal(closed['cache-control'], 'no-store');
  assert.doesNotMatch(embedShellHtml(null, options, 'n1'), /type="module"/);

  const policy = {
    tenantId: 't',
    tenantAlias: 'demo',
    origins: ['https://crm.example.test', 'https://sales.example.test'],
  };
  const open = embedShellHeaders(policy, options, 'n2');
  assert.match(
    open['content-security-policy']!,
    /frame-ancestors https:\/\/crm\.example\.test https:\/\/sales\.example\.test$/,
  );
  assert.match(
    open['content-security-policy']!,
    /script-src 'nonce-n2' https:\/\/workspace\.dcontact\.test/,
  );
  assert.doesNotMatch(open['content-security-policy']!, /unsafe-inline|\*/);
  const html = embedShellHtml(policy, options, 'n2');
  const config = JSON.parse(/id="dphone-embed-config"[^>]*>([^<]*)</.exec(html)![1]!);
  assert.deepEqual(config, { v: 1, tenant: 'demo', allowedHostOrigins: policy.origins });
  assert.match(html, /<script type="module" nonce="n2" src="https:\/\/workspace\.dcontact\.test/);

  // ค่าใน JSON ต้องปิด tag ก่อนเวลาไม่ได้
  const hostile = embedShellHtml(
    { ...policy, tenantAlias: '</script><script>alert(1)</script>' },
    options,
    'n3',
  );
  assert.equal(hostile.includes('</script><script>alert'), false);
});
