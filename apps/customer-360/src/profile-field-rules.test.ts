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
