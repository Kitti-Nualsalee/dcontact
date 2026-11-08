import test from 'node:test';
import assert from 'node:assert/strict';
import { c360ProfileFieldRules } from './profile-field-rules.js';
import { C360_PROFILE_WRITE_VERSION, normalizeC360CreateProfile } from './profile-write.js';

test('registry และ writer ตรง version/name-company boundaries และ VIP type', () => {
  const rules = c360ProfileFieldRules();
  assert.equal(rules.version, C360_PROFILE_WRITE_VERSION);
  for (const name of ['displayName', 'company'] as const) {
    const rule = rules.fields.find((x) => x.name === name)!;
    const max = (rule.constraints as { maxCodeUnits: number }).maxCodeUnits;
    assert.doesNotThrow(() =>
      normalizeC360CreateProfile({ displayName: 'fixture', [name]: 'ก'.repeat(max) }),
    );
    assert.throws(() =>
      normalizeC360CreateProfile({ displayName: 'fixture', [name]: 'ก'.repeat(max + 1) }),
    );
  }
  assert.equal(
    normalizeC360CreateProfile({ displayName: '  ก\u0e32  ', company: null, vip: false }).company,
    null,
  );
  assert.throws(() => normalizeC360CreateProfile({ displayName: 'fixture', vip: 'true' }));
  assert.throws(() => normalizeC360CreateProfile({ displayName: '' }));
});

test('email registry ตรง writer: IDNA ใช้ตรวจเท่านั้น ไม่รวม U-label กับ A-label หรือ normalize NFC', () => {
  const rules = c360ProfileFieldRules();
  const metadata = rules.fields.find((field) => field.name === 'email')!;
  assert.equal(
    metadata.normalization,
    'trim,preserve-local-tokens,lowercase-domain,IDNA-validation-only,no-punycode,no-NFC,no-NFKC',
  );
  const vectors = [
    ['  User@BÜCHER.DE  ', 'User@bücher.de'],
    ['User@xn--bcher-kva.de', 'User@xn--bcher-kva.de'],
    ['User@BU\u0308CHER.DE', 'User@bu\u0308cher.de'],
  ] as const;
  const keys = vectors.map(([input, expected]) => {
    const point = normalizeC360CreateProfile({
      displayName: 'fixture',
      points: [{ kind: 'EMAIL', value: input }],
    }).points[0]!;
    assert.equal(point.normalizedValue, expected);
    assert.equal(point.normalizationVersion, metadata.normalizationVersion);
    return point.normalizedValue;
  });
  assert.equal(
    new Set(keys).size,
    vectors.length,
    'U-label, A-label และ decomposed domain ไม่ใช้ key เดียวกัน',
  );
});
