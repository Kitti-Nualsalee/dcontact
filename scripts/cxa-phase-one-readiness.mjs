import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeReadinessCheck, skippedDiagnostic } from './phase-zero-readiness.mjs';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const CXA_PHASE_ONE_READINESS_CHECKS = [
  {
    id: 'phase-two-regression',
    dependency: 'Inbound Voice Phase 2 regression baseline',
    boundaries: ['INBOUND_VOICE_PHASE_2_PILOT_READY', 'Journey ไม่อยู่ใน inbound critical path'],
    command: [pnpm, 'voice:phase2:acceptance'],
    remediation: 'แก้ Phase 2 regression blocker ก่อนประเมิน CX Automation',
  },
  {
    id: 'canonical-storage',
    dependency: 'Contact Governance และ Journey canonical storage',
    boundaries: [
      'existing database migration',
      'fresh database migration',
      'RLS',
      'canonical CG/JR models',
    ],
    command: [process.execPath, 'scripts/cxa-schema-readiness.mjs'],
    remediation: 'ตรวจ CG/JR migration, Prisma schema และ tenant RLS policy',
  },
  {
    id: 'tenant-isolation',
    dependency: 'Application-role tenant isolation semantics',
    boundaries: ['cross-tenant read denial', 'cross-tenant mutation denial', 'append-only audit'],
    command: [pnpm, '--filter', '@d-contact/db', 'test:integration'],
    remediation: 'ตรวจ service role privileges และ RLS USING/WITH CHECK ของ CG/JR tables',
  },
  {
    id: 'service-identity',
    dependency: 'Keycloak tenant-bound machine identity',
    boundaries: [
      'real Keycloak token endpoint',
      'OAuth2 client_credentials',
      'journey-ingress role',
      'two tenant service identities',
    ],
    command: [process.execPath, 'scripts/cxa-service-identity-readiness.mjs'],
    remediation: 'รัน pnpm infra:identity:link แล้วตรวจ Keycloak service account claims',
  },
  {
    id: 'governance-contract',
    dependency: 'Contact policy และ reservation state contract',
    boundaries: [
      'hard restriction',
      'revoked/expired consent',
      'fail-closed delivery',
      'idempotent lifecycle',
    ],
    command: [pnpm, '--filter', '@d-contact/contact-governance', 'test'],
    remediation: 'ตรวจ policy precedence และ reservation state transition',
  },
  {
    id: 'governance-database',
    dependency: 'Atomic Contact Governance database boundary',
    boundaries: [
      'authorizeAndReserve',
      'idempotency conflict',
      'expiry sweeper',
      'decision/reservation transaction',
    ],
    command: [pnpm, '--filter', '@d-contact/contact-governance', 'test:integration'],
    remediation: 'ตรวจ PostgreSQL advisory lock, actionKey และ reservation transaction',
  },
  {
    id: 'journey-contract',
    dependency: 'Journey deterministic identity contract',
    boundaries: ['stable actionKey', 'enrollmentId', 'journeyVersion', 'stepId'],
    command: [pnpm, '--filter', '@d-contact/journey', 'test'],
    remediation: 'ตรวจ Journey action identity และ canonical event hashing',
  },
  {
    id: 'journey-event-action',
    dependency: 'Durable Journey event-to-action boundary',
    boundaries: [
      'durable event inbox',
      'Kafka recovery',
      'IDENTITY_AMBIGUOUS',
      'decision/reservation link',
      'two tenant isolation',
    ],
    command: [pnpm, '--filter', '@d-contact/journey', 'test:integration'],
    remediation: 'ตรวจ event inbox, Redpanda, identity resolution และ Journey processor',
  },
  {
    id: 'service-ingress',
    dependency: 'External business event ingress',
    boundaries: [
      'OAuth2 client_credentials',
      'verified tenant context',
      'durable receipt',
      'HTTP 409 IDEMPOTENCY_CONFLICT',
    ],
    command: [pnpm, '--filter', '@d-contact/api', 'test:integration'],
    remediation: 'ตรวจ Keycloak service identity, role journey-ingress และ POST /api/v1/events',
  },
  {
    id: 'compile-boundary',
    dependency: 'Repository type boundary',
    boundaries: ['TypeScript workspace graph', 'public package contracts'],
    command: [pnpm, 'typecheck'],
    remediation: 'แก้ type error ของ package contracts ก่อนยอมรับ Phase 1',
  },
];

export function cxaPhaseOneSummary(diagnostics, startedAt = new Date()) {
  const failed = diagnostics.filter(({ status }) => status === 'FAIL');
  return {
    type: 'readiness.summary',
    workflow: 'cx-automation-phase-1-acceptance',
    workflowVersion: 1,
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: diagnostics.filter(({ status }) => status === 'PASS').length,
    failed: failed.length,
    skipped: diagnostics.filter(({ status }) => status === 'SKIP').length,
    entryCondition: failed.length === 0 ? 'CX_AUTOMATION_PHASE_1_ACCEPTED' : 'NOT_READY',
    evidenceScope: 'development acceptance baseline',
  };
}

export function runCxaPhaseOneReadiness() {
  const startedAt = new Date();
  const diagnostics = [];
  let blocker;

  for (const check of CXA_PHASE_ONE_READINESS_CHECKS) {
    const diagnostic = blocker ? skippedDiagnostic(check, blocker) : executeReadinessCheck(check);
    diagnostics.push(diagnostic);
    process.stdout.write(`${JSON.stringify({ type: 'readiness.check', ...diagnostic })}\n`);
    if (diagnostic.status === 'FAIL') blocker = diagnostic.checkId;
  }

  const summary = cxaPhaseOneSummary(diagnostics, startedAt);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const summary = runCxaPhaseOneReadiness();
  if (summary.status === 'FAIL') process.exitCode = 1;
}
