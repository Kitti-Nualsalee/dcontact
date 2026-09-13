import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  Cg4CanonicalChangePayloadV1,
  ContactAuthorizationPort,
} from '@d-contact/cxa-contracts';
import { createCg4CanonicalChangePayloadFixture } from '@d-contact/cxa-contracts/testing/cg4-fixtures.js';
import type { KafkaEventEnvelopeV2 } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  CG4_PLATFORM_LIFETIME_CAP_SECONDS,
  CG4_RULE_CODES,
  CG4_RULE_REGISTRY,
  resolveCg4OverrideEligibility,
  resolveCg4RuleMetadata,
} from './cg4-rule-registry.js';

const REQUIRED_NON_OVERRIDABLE = [
  'IDENTITY_AMBIGUOUS',
  'IDENTITY_NOT_FOUND',
  'TENANT_SCOPE_NOT_ALLOWED',
  'TEAM_SEGMENT_NOT_ALLOWED',
  'CAPABILITY_REQUIRED',
  'AUTHORIZATION_CONTEXT_UNAVAILABLE',
  'DNC_GLOBAL',
  'PURPOSE_OBJECTED',
  'CONSENT_REVOKED',
  'CONSENT_REQUIRED',
  'CONSENT_EXPIRED',
  'LAWFUL_BASIS_REQUIRED',
  'REGULATORY_RESTRICTION',
  'SAFETY_RESTRICTION',
  'PREFERENCE_BLOCKED',
  'PREFERENCE_DEFERRED',
  'TIMEZONE_UNKNOWN',
  'SENDER_IDENTITY_REQUIRED',
  'SENDER_IDENTITY_INVALID',
  'GOVERNANCE_KILL_SWITCH_ACTIVE',
  'OUTBOUND_TRAFFIC_DISABLED',
  'GOVERNANCE_VERSION_STALE',
  'GOVERNANCE_STATE_UNAVAILABLE',
  'GOVERNANCE_POLICY_VERSION_UNSUPPORTED',
  'CALLBACK_OVERRIDE_NOT_ALLOWED',
  'CALLBACK_OVERRIDE_EXPIRED',
] as const;

test('CG4-F01: hard boundary ทั้งหมดเป็น non-overridable และ registry immutable', () => {
  assert.ok(Object.isFrozen(CG4_RULE_REGISTRY));
  assert.deepEqual(
    Object.values(CG4_RULE_REGISTRY)
      .filter((metadata) => metadata.ruleClass === 'NON_OVERRIDABLE')
      .map((metadata) => metadata.ruleCode)
      .sort(),
    [...REQUIRED_NON_OVERRIDABLE].sort(),
  );
  for (const ruleCode of REQUIRED_NON_OVERRIDABLE) {
    const resolution = resolveCg4RuleMetadata(ruleCode);
    assert.equal(resolution.known, true, ruleCode);
    assert.equal(resolution.metadata.ruleClass, 'NON_OVERRIDABLE', ruleCode);
    assert.equal(resolution.metadata.overridable, false, ruleCode);
    assert.deepEqual(resolution.metadata.allowedOverrideMechanisms, [], ruleCode);
    assert.ok(Object.isFrozen(resolution.metadata), ruleCode);
  }
});

test('unknown rule metadata fail closed แทนการรับ metadata จาก caller', () => {
  const resolution = resolveCg4RuleMetadata('CALLER_INVENTED_ALLOW');
  assert.equal(resolution.known, false);
  assert.equal(resolution.metadata.ruleClass, 'NON_OVERRIDABLE');
  assert.equal(resolution.metadata.overridable, false);

  const eligibility = resolveCg4OverrideEligibility({
    ruleCode: 'CALLER_INVENTED_ALLOW',
    mechanism: 'APPROVED_EXCEPTION',
    identityScope: 'EXACT_IDENTITY',
    policyAllowedRuleCodes: ['CALLER_INVENTED_ALLOW'],
    riskTier: 'STANDARD',
    requestedRuleCount: 1,
    lifetimeSeconds: 60,
  });
  assert.equal(eligibility.eligible, false);
  if (!eligibility.eligible) assert.equal(eligibility.reason, 'RULE_NOT_REGISTERED');
});

test('CG4-REG02 contract: approved exception ต้องผ่าน registry + policy positive allowlist', () => {
  const allowed = resolveCg4OverrideEligibility({
    ruleCode: CG4_RULE_CODES.QUIET_HOURS,
    mechanism: 'APPROVED_EXCEPTION',
    identityScope: 'EXACT_IDENTITY',
    policyAllowedRuleCodes: [CG4_RULE_CODES.QUIET_HOURS],
    riskTier: 'STANDARD',
    requestedRuleCount: 1,
    lifetimeSeconds: CG4_PLATFORM_LIFETIME_CAP_SECONDS.STANDARD,
  });
  assert.equal(allowed.eligible, true);

  const notEnabled = resolveCg4OverrideEligibility({
    ruleCode: CG4_RULE_CODES.QUIET_HOURS,
    mechanism: 'APPROVED_EXCEPTION',
    identityScope: 'EXACT_IDENTITY',
    policyAllowedRuleCodes: [],
    riskTier: 'STANDARD',
    requestedRuleCount: 1,
    lifetimeSeconds: 60,
  });
  assert.equal(notEnabled.eligible, false);
  if (!notEnabled.eligible) assert.equal(notEnabled.reason, 'RULE_NOT_ENABLED_BY_POLICY');

  const hardRule = resolveCg4OverrideEligibility({
    ruleCode: CG4_RULE_CODES.DNC_GLOBAL,
    mechanism: 'APPROVED_EXCEPTION',
    identityScope: 'EXACT_IDENTITY',
    policyAllowedRuleCodes: [CG4_RULE_CODES.DNC_GLOBAL],
    riskTier: 'EMERGENCY',
    requestedRuleCount: 1,
    lifetimeSeconds: 60,
  });
  assert.equal(hardRule.eligible, false);
  if (!hardRule.eligible) assert.equal(hardRule.reason, 'NON_OVERRIDABLE_RULE');
});

test('customer callback ไม่เปิดทางให้ generic exception ข้าม explicit preference', () => {
  const callback = resolveCg4OverrideEligibility({
    ruleCode: CG4_RULE_CODES.PREFERENCE_WINDOW_CLOSED,
    mechanism: 'CUSTOMER_CALLBACK',
    identityScope: 'EXACT_IDENTITY',
    policyAllowedRuleCodes: [CG4_RULE_CODES.PREFERENCE_WINDOW_CLOSED],
    riskTier: 'STANDARD',
    requestedRuleCount: 1,
    lifetimeSeconds: 60,
  });
  assert.equal(callback.eligible, true);

  const genericException = resolveCg4OverrideEligibility({
    ruleCode: CG4_RULE_CODES.PREFERENCE_WINDOW_CLOSED,
    mechanism: 'APPROVED_EXCEPTION',
    identityScope: 'EXACT_IDENTITY',
    policyAllowedRuleCodes: [CG4_RULE_CODES.PREFERENCE_WINDOW_CLOSED],
    riskTier: 'STANDARD',
    requestedRuleCount: 1,
    lifetimeSeconds: 60,
  });
  assert.equal(genericException.eligible, false);
  if (!genericException.eligible) {
    assert.equal(genericException.reason, 'OVERRIDE_MECHANISM_NOT_ALLOWED');
  }
});

test('risk floor และ platform lifetime cap ลดสิทธิ์แบบ deterministic', () => {
  const lowRisk = resolveCg4OverrideEligibility({
    ruleCode: CG4_RULE_CODES.DAILY_TOUCH_CAP,
    mechanism: 'APPROVED_EXCEPTION',
    identityScope: 'EXACT_IDENTITY',
    policyAllowedRuleCodes: [CG4_RULE_CODES.DAILY_TOUCH_CAP],
    riskTier: 'STANDARD',
    requestedRuleCount: 1,
    lifetimeSeconds: 60,
  });
  assert.equal(lowRisk.eligible, false);
  if (!lowRisk.eligible) assert.equal(lowRisk.reason, 'RISK_TIER_TOO_LOW');

  const contactWideStandard = resolveCg4OverrideEligibility({
    ruleCode: CG4_RULE_CODES.QUIET_HOURS,
    mechanism: 'APPROVED_EXCEPTION',
    identityScope: 'CONTACT_WIDE',
    policyAllowedRuleCodes: [CG4_RULE_CODES.QUIET_HOURS],
    riskTier: 'STANDARD',
    requestedRuleCount: 1,
    lifetimeSeconds: 60,
  });
  assert.equal(contactWideStandard.eligible, false);
  if (!contactWideStandard.eligible) {
    assert.equal(contactWideStandard.reason, 'RISK_TIER_TOO_LOW');
  }

  const unknownRisk = resolveCg4OverrideEligibility({
    ruleCode: CG4_RULE_CODES.QUIET_HOURS,
    mechanism: 'APPROVED_EXCEPTION',
    identityScope: 'EXACT_IDENTITY',
    policyAllowedRuleCodes: [CG4_RULE_CODES.QUIET_HOURS],
    riskTier: 'BREAK_GLASS' as never,
    requestedRuleCount: 1,
    lifetimeSeconds: 60,
  });
  assert.equal(unknownRisk.eligible, false);
  if (!unknownRisk.eligible) assert.equal(unknownRisk.reason, 'RISK_TIER_UNSUPPORTED');

  const emergencyTooLong = resolveCg4OverrideEligibility({
    ruleCode: CG4_RULE_CODES.QUIET_HOURS,
    mechanism: 'APPROVED_EXCEPTION',
    identityScope: 'CONTACT_WIDE',
    policyAllowedRuleCodes: [CG4_RULE_CODES.QUIET_HOURS],
    riskTier: 'EMERGENCY',
    requestedRuleCount: 1,
    lifetimeSeconds: CG4_PLATFORM_LIFETIME_CAP_SECONDS.EMERGENCY + 1,
  });
  assert.equal(emergencyTooLong.eligible, false);
  if (!emergencyTooLong.eligible) assert.equal(emergencyTooLong.reason, 'LIFETIME_EXCEEDS_CAP');
});

test('CG4 payload คง Kafka envelope V2 และ public authorization port แบบ structural', () => {
  const payload = createCg4CanonicalChangePayloadFixture();
  const event: KafkaEventEnvelopeV2<Cg4CanonicalChangePayloadV1> = {
    schemaVersion: 2,
    eventKind: 'CANONICAL',
    eventId: 'event-fixture-001',
    type: 'exception.changed',
    tenantId: 'tenant-fixture-001',
    occurredAt: '2026-09-15T10:00:00.000Z',
    correlationId: 'mutation-fixture-001',
    orderingKey: 'tenant-fixture-001:contact-fixture-001',
    aggregateType: 'contact_governance_contact',
    aggregateId: 'contact-fixture-001',
    aggregateVersion: 2,
    payload,
  };
  const unchangedPortShape: ContactAuthorizationPort | undefined = undefined;
  assert.equal(KAFKA_TOPICS.CONTACT_GOVERNANCE_EVENTS, 'dc.contact-governance.events');
  assert.equal(event.schemaVersion, 2);
  assert.equal(event.payload.contractVersion, 1);
  assert.equal(event.payload.affectedScope.contactKind, 'PERSONAL');
  assert.equal(unchangedPortShape, undefined);
});
