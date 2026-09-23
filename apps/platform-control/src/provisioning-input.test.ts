import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROVISIONING_REQUEST_STATUSES,
  PROVISIONING_REQUEST_TRANSITIONS,
  PlatformProvisioningError,
  TERMINAL_PROVISIONING_STATUSES,
  isAllowedProvisioningTransition,
  type ProvisioningRequestInput,
} from '@d-contact/shared';
import {
  canonicalizeProvisioningRequest,
  deriveTenantSipDomain,
  normalizeFirstAdminEmail,
  normalizePrimaryDomain,
  normalizeTenantSlug,
  platformIdentityHash,
  provisioningPayloadDigest,
} from './provisioning-input.js';

const input: ProvisioningRequestInput = {
  displayName: '  Acme   Contact  Center ',
  slug: ' Acme-CC ',
  primaryDomain: 'ACME.co.th.',
  locale: 'th-TH',
  timezone: 'Asia/Bangkok',
  planCode: 'growth',
  bootstrapTemplateVersion: 'baseline-v1',
  firstAdmin: { email: 'Ops.Lead@ACME.CO.TH', displayName: ' Ops Lead ' },
};

test('A1.1 slug: lowercase DNS label เท่านั้น — ค่าผิดรูปคืน null', () => {
  assert.equal(normalizeTenantSlug(' Acme-CC '), 'acme-cc');
  for (const invalid of [
    '-acme',
    'acme-',
    'ac',
    'a--b',
    'acme_cc',
    'acme.cc',
    '~pv-x',
    'a'.repeat(64),
  ]) {
    assert.equal(normalizeTenantSlug(invalid), null, invalid);
  }
});

test('A1.1 domain: lowercase IDNA ไม่มี trailing dot และต้องมีอย่างน้อยสอง label', () => {
  assert.equal(normalizePrimaryDomain('ACME.co.th.'), 'acme.co.th');
  assert.equal(normalizePrimaryDomain('ตัวอย่าง.ไทย'), 'xn--72c1a1bt4awk9o.xn--o3cw4h');
  for (const invalid of [
    'localhost',
    'acme.co.th/path',
    'user@acme.co.th',
    'acme.co.th:443',
    '-a.com',
    '',
  ]) {
    assert.equal(normalizePrimaryDomain(invalid), null, invalid);
  }
});

test('A1.1 email: domain เป็น canonical แต่ local part คงเดิม', () => {
  assert.equal(normalizeFirstAdminEmail('Ops.Lead@ACME.CO.TH'), 'Ops.Lead@acme.co.th');
  assert.equal(normalizeFirstAdminEmail('not-an-email'), null);
  assert.equal(normalizeFirstAdminEmail('a b@acme.co.th'), null);
});

test('A1.1 sipDomain derive จาก slug + base ของ platform (decision บน #406)', () => {
  assert.equal(deriveTenantSipDomain('acme-cc', 'SIP.dcontact.app'), 'acme-cc.sip.dcontact.app');
  assert.throws(() => deriveTenantSipDomain('acme-cc', 'nope'), PlatformProvisioningError);
});

test('A1.1 canonical payload: whitespace/ตัวพิมพ์/ลำดับ field ไม่ทำให้ digest ต่าง', () => {
  const canonical = canonicalizeProvisioningRequest(input);
  assert.deepEqual(canonical, {
    displayName: 'Acme Contact Center',
    slug: 'acme-cc',
    primaryDomain: 'acme.co.th',
    locale: 'th-TH',
    timezone: 'Asia/Bangkok',
    planCode: 'growth',
    bootstrapTemplateVersion: 'baseline-v1',
    firstAdminEmail: 'Ops.Lead@acme.co.th',
    firstAdminDisplayName: 'Ops Lead',
  });
  const reordered = canonicalizeProvisioningRequest({
    firstAdmin: { displayName: 'Ops Lead', email: 'Ops.Lead@acme.co.th' },
    bootstrapTemplateVersion: 'baseline-v1',
    planCode: 'growth',
    timezone: 'Asia/Bangkok',
    locale: 'th-TH',
    primaryDomain: 'acme.co.th',
    slug: 'acme-cc',
    displayName: 'Acme Contact Center',
  });
  assert.equal(provisioningPayloadDigest(reordered), provisioningPayloadDigest(canonical));
  const changed = canonicalizeProvisioningRequest({ ...input, planCode: 'starter' });
  assert.notEqual(provisioningPayloadDigest(changed), provisioningPayloadDigest(canonical));
});

test('A1.1 validation: รวม field error ทุกตัวในครั้งเดียวด้วย code คงที่', () => {
  try {
    canonicalizeProvisioningRequest({
      ...input,
      slug: '!',
      primaryDomain: 'x',
      timezone: 'Mars/Base',
      planCode: 'free' as never,
      firstAdmin: { email: 'nope', displayName: '' },
    });
    assert.fail('ต้อง throw');
  } catch (error) {
    assert.ok(error instanceof PlatformProvisioningError);
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.deepEqual(Object.keys(error.fieldErrors ?? {}).sort(), [
      'firstAdmin.displayName',
      'firstAdmin.email',
      'planCode',
      'primaryDomain',
      'slug',
      'timezone',
    ]);
  }
});

test('A1.1 identity hash แยกตามชนิดและไม่คืนค่าดิบ', () => {
  const email = 'Ops.Lead@acme.co.th';
  const hash = platformIdentityHash('first-admin-email', email);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, platformIdentityHash('idempotency-key', email));
});

test('A1.1 transition table ตรง #389: terminal ไม่ไปไหน, CANCELLED เฉพาะก่อน side effect', () => {
  for (const status of TERMINAL_PROVISIONING_STATUSES) {
    assert.deepEqual(PROVISIONING_REQUEST_TRANSITIONS[status], []);
  }
  assert.equal(isAllowedProvisioningTransition('PENDING', 'CANCELLED'), true);
  assert.equal(isAllowedProvisioningTransition('RUNNING', 'CANCELLED'), false);
  assert.equal(
    isAllowedProvisioningTransition('RUNNING', 'FAILED_FINAL'),
    false,
    'timeout ต้องผ่าน ACTION_REQUIRED',
  );
  assert.equal(isAllowedProvisioningTransition('ACTION_REQUIRED', 'RUNNING'), true);
  assert.equal(isAllowedProvisioningTransition('PENDING', 'SUCCEEDED'), false);
  assert.equal(
    Object.keys(PROVISIONING_REQUEST_TRANSITIONS).length,
    PROVISIONING_REQUEST_STATUSES.length,
  );
});
