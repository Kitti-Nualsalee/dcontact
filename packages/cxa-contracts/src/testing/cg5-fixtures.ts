import { contactMutationId } from '../identifiers.js';
import { canonicalCg4Digest } from '../contact-governance-cg4.js';
import {
  CG5_CONTRACT_VERSION,
  CG5_DEFAULT_TENANT_CONFIG,
  CG5_MANIFEST_SCHEMA_VERSION,
  CG5_RULE_REGISTRY_VERSION,
  cg5AlertScopeKey,
  type Cg5AlertChangedPayloadV1,
  type Cg5ExportChangedPayloadV1,
  type Cg5ExportManifestV1,
  type Cg5TenantConfigV1,
} from '../contact-governance-cg5.js';

const FIXTURE_TIME = '2026-09-17T03:00:00.000Z';

/** fixture สังเคราะห์ที่ไม่มี PII และให้ผล deterministic; test override เฉพาะ field ที่เกี่ยวกับ case */
export function createCg5AlertChangedPayloadFixture(
  overrides: Partial<Cg5AlertChangedPayloadV1> = {},
): Cg5AlertChangedPayloadV1 {
  const base: Cg5AlertChangedPayloadV1 = {
    contractVersion: CG5_CONTRACT_VERSION,
    mutationId: contactMutationId('cg5-alert-mutation-fixture-001'),
    subjectId: 'alert-fixture-001',
    subjectVersion: 3,
    effectiveAt: FIXTURE_TIME,
    stateDigest: canonicalCg4Digest({ alert: 'fixture', version: 3 }),
    ruleCode: 'CG5_BLOCK_RATE_SHIFT',
    severity: 'CRITICAL',
    state: 'OPEN',
    scopeKey: cg5AlertScopeKey({
      channel: 'LINE',
      purpose: 'COLLECTION',
      teamId: 'team-fixture-1',
    }),
    registryVersion: CG5_RULE_REGISTRY_VERSION,
  };
  return { ...base, ...overrides };
}

export function createCg5ExportChangedPayloadFixture(
  overrides: Partial<Cg5ExportChangedPayloadV1> = {},
): Cg5ExportChangedPayloadV1 {
  const base: Cg5ExportChangedPayloadV1 = {
    contractVersion: CG5_CONTRACT_VERSION,
    mutationId: contactMutationId('cg5-export-mutation-fixture-001'),
    subjectId: 'export-fixture-001',
    subjectVersion: 2,
    effectiveAt: FIXTURE_TIME,
    stateDigest: canonicalCg4Digest({ export: 'fixture', version: 2 }),
    state: 'READY',
    datasets: ['DECISION_TRACE', 'AUDIT_LOG'],
    evidenceLevel: 'SUMMARY',
    manifestDigest: canonicalCg4Digest({ manifest: 'fixture' }),
  };
  return { ...base, ...overrides };
}

export function createCg5ExportManifestFixture(
  overrides: Partial<Cg5ExportManifestV1> = {},
): Cg5ExportManifestV1 {
  const base: Cg5ExportManifestV1 = {
    contractVersion: CG5_CONTRACT_VERSION,
    manifestSchemaVersion: CG5_MANIFEST_SCHEMA_VERSION,
    exportId: 'export-fixture-001',
    datasets: ['DECISION_TRACE', 'AUDIT_LOG'],
    evidenceLevel: 'SUMMARY',
    rangeFrom: '2026-08-01T00:00:00.000Z',
    rangeTo: '2026-08-31T23:59:59.999Z',
    rowCounts: {
      DECISION_TRACE: 1_284_003,
      AUDIT_LOG: 4_120,
      RESTRICTION_CONSENT: 0,
      EXCEPTION_APPROVAL: 0,
    },
    fileDigests: {
      'decision-trace.csv': canonicalCg4Digest({ file: 'decision-trace' }),
      'audit-log.csv': canonicalCg4Digest({ file: 'audit-log' }),
    },
    requestedByRef: 'subject:compliance-fixture-01',
    generatedAt: FIXTURE_TIME,
    tenantWatermark: 'tenant-fixture-0001',
  };
  return { ...base, ...overrides };
}

export function createCg5TenantConfigFixture(
  overrides: Partial<Cg5TenantConfigV1> = {},
): Cg5TenantConfigV1 {
  return { ...CG5_DEFAULT_TENANT_CONFIG, ...overrides };
}
