import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { executeReadinessCheck, skippedDiagnostic } from './phase-zero-readiness.mjs';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const PHASE_ONE_READINESS_CHECKS = [
  {
    id: 'phase-zero',
    dependency: 'Phase 0 readiness',
    boundaries: ['infrastructure, RLS, identity and event backbone baseline'],
    command: [pnpm, 'infra:ready'],
    remediation: 'แก้ readiness dependency ที่รายงานแล้วรัน pnpm voice:acceptance ซ้ำ',
  },
  {
    id: 'two-tenant-identity',
    dependency: 'Keycloak Organizations สอง tenant',
    boundaries: ['Keycloak Organizations', 'distinct tenant claims', 'PostgreSQL user mapping'],
    command: [process.execPath, 'scripts/keycloak-dev-readiness.mjs', '--auto-fallback'],
    remediation: 'รัน pnpm infra:bootstrap เพื่อ provision Organization และ identity ใหม่',
  },
  {
    id: 'event-contract',
    dependency: 'Kafka contract',
    boundaries: ['event tenant header/payload', 'ordering', 'idempotency'],
    command: [pnpm, '--filter', '@d-contact/kafka', 'test'],
    remediation: 'ตรวจ @d-contact/kafka และ shared event contracts',
  },
  {
    id: 'routing-lifecycle',
    dependency: 'Inbound Voice Router integration',
    boundaries: ['routing policy', 'no-answer', 'wrap-up', 'direct queue', 'IVR'],
    command: [pnpm, '--filter', '@d-contact/router', 'test:integration'],
    remediation: 'ตรวจ Router lifecycle, queue policy และ IVR integration tests',
  },
  {
    id: 'workspace-runtime',
    dependency: 'Agent Workspace runtime',
    boundaries: ['single working tab', 'offer acknowledgement', 'snapshot/sequence recovery'],
    command: [pnpm, '--filter', '@d-contact/workspace', 'test'],
    remediation: 'ตรวจ Workspace leader election, session และ sequenced event recovery',
  },
  {
    id: 'workspace-supervisor-api',
    dependency: 'Workspace/API integration',
    boundaries: ['supervisor control', 'team scope', 'signed playback', 'human publish'],
    command: [pnpm, '--filter', '@d-contact/api', 'test:integration'],
    evidencePrefix: 'PHASE_ONE_EVIDENCE ',
    remediation: 'ตรวจ API authorization, supervisor scope, recording และ QM endpoints',
  },
  {
    id: 'recording-contract',
    dependency: 'Telephony recording contract',
    boundaries: ['announcement/start', 'tenant-safe MinIO archive', 'signed playback source'],
    command: [pnpm, '--filter', '@d-contact/telephony', 'test'],
    remediation: 'ตรวจ FreeSWITCH recording command และ MinIO archive adapter',
  },
  {
    id: 'recording-finalization',
    dependency: 'Telephony recording lifecycle',
    boundaries: [
      'hangup finalization',
      'duration capture',
      'durable archive retry',
      'archive idempotency',
    ],
    command: [pnpm, '--filter', '@d-contact/telephony', 'test:integration'],
    remediation: 'ตรวจ shared recording volume และ recording lifecycle',
  },
  {
    id: 'qm-provider-contract',
    dependency: 'QM provider contract',
    boundaries: ['encrypted media URL', 'NO_TRAINING', 'provider response validation'],
    command: [pnpm, '--filter', '@d-contact/qm', 'test'],
    remediation: 'ตรวจ TranscriptionProvider และ HTTPS/no-training contract',
  },
  {
    id: 'thai-qm-pipeline',
    dependency: 'Thai transcription/QM integration',
    boundaries: ['Thai baseline', 'FAILED/retry/audit', 'evidence-backed DRAFT'],
    command: [pnpm, '--filter', '@d-contact/qm', 'test:integration'],
    evidencePrefix: 'PHASE_ONE_EVIDENCE ',
    remediation: 'ตรวจ QM workflow, bounded retry, audit และ Thai corpus fixture',
  },
  {
    id: 'two-tenant-e2e',
    dependency: 'Two-tenant recording-to-QM acceptance',
    boundaries: [
      'recording-to-QM human publish',
      'agent/queue/interaction/recording/transcript/QM isolation',
      'API/event/persistence/signed playback isolation',
    ],
    command: [pnpm, '--filter', '@d-contact/phase-one-acceptance', 'test'],
    evidencePrefix: 'PHASE_ONE_EVIDENCE ',
    remediation: 'ตรวจ Phase 1 two-tenant acceptance fixture และ RLS policies',
  },
  {
    id: 'direct-queue-e2e',
    dependency: 'FreeSWITCH direct queue demo',
    boundaries: ['direct queue', 'softphone media', 'recording', 'wrap-up completed'],
    command: [pnpm, 'voice:demo'],
    evidencePrefix: 'PHASE_ONE_EVIDENCE ',
    remediation: 'ตรวจ FreeSWITCH/SIPp, Router, Telephony และ shared recording volume',
  },
  {
    id: 'ivr-e2e',
    dependency: 'FreeSWITCH IVR demo',
    boundaries: ['IVR', 'DTMF fallback', 'softphone media', 'recording', 'wrap-up completed'],
    command: [pnpm, 'voice:ivr:demo'],
    evidencePrefix: 'PHASE_ONE_EVIDENCE ',
    remediation: 'ตรวจ IVR destination, DTMF event และ FreeSWITCH media path',
  },
];

export function phaseOneSummary(diagnostics, startedAt = new Date()) {
  const failed = diagnostics.filter(({ status }) => status === 'FAIL');
  return {
    type: 'readiness.summary',
    workflow: 'inbound-voice-phase-1-acceptance',
    workflowVersion: 1,
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: diagnostics.filter(({ status }) => status === 'PASS').length,
    failed: failed.length,
    skipped: diagnostics.filter(({ status }) => status === 'SKIP').length,
    entryCondition: failed.length === 0 ? 'INBOUND_VOICE_PHASE_1_ACCEPTED' : 'NOT_READY',
    evidenceScope: 'development acceptance baseline; not a production SLA',
  };
}

export function runPhaseOneReadiness() {
  const startedAt = new Date();
  const diagnostics = [];
  let blocker;
  for (const check of PHASE_ONE_READINESS_CHECKS) {
    const diagnostic = blocker ? skippedDiagnostic(check, blocker) : executeReadinessCheck(check);
    diagnostics.push(diagnostic);
    process.stdout.write(`${JSON.stringify({ type: 'readiness.check', ...diagnostic })}\n`);
    if (diagnostic.status === 'FAIL') blocker = diagnostic.checkId;
  }
  const summary = phaseOneSummary(diagnostics, startedAt);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const summary = runPhaseOneReadiness();
  if (summary.status === 'FAIL') process.exitCode = 1;
}
