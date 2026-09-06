import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { executeReadinessCheck, skippedDiagnostic } from './phase-zero-readiness.mjs';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const PHASE_TWO_READINESS_CHECKS = [
  {
    id: 'phase-one-baseline',
    dependency: 'INBOUND_VOICE_PHASE_1_ACCEPTED baseline',
    boundaries: ['INBOUND_VOICE_PHASE_1_ACCEPTED', 'routing', 'recording-to-QM'],
    command: [pnpm, 'voice:acceptance'],
    remediation: 'แก้ Phase 1 blocker ก่อนเริ่มประเมิน Pilot browser layer',
  },
  {
    id: 'keycloak-console-context',
    dependency: 'Keycloak Organizations และ opaque Console context',
    boundaries: ['Keycloak Organizations', 'Authorization Code + PKCE', 'opaque Console context'],
    command: [pnpm, '--filter', '@d-contact/api', 'test:integration'],
    evidencePrefix: 'PHASE_ONE_EVIDENCE ',
    remediation: 'ตรวจ OIDC claims, Console context expiry และ tenant/user scope',
  },
  {
    id: 'command-boundary',
    dependency: 'server-side idempotent command และ force-safe control',
    boundaries: ['idempotent command', 'force-safe', 'tenant-scoped audit'],
    command: [pnpm, '--filter', '@d-contact/api', 'test:integration'],
    remediation: 'ตรวจ command receipt, scope และ remote-control safety boundary',
  },
  {
    id: 'workspace-browser',
    dependency: 'Workspace deterministic browser acceptance',
    boundaries: [
      'Playwright Chromium',
      'single working tab',
      'media readiness',
      'Supervisor scope',
    ],
    command: [pnpm, '--filter', '@d-contact/workspace', 'test:e2e'],
    remediation: 'ตรวจ Workspace browser fixture, media/SIP adapter และ role scope',
  },
  {
    id: 'console-browser',
    dependency: 'Console deterministic browser acceptance',
    boundaries: ['Playwright Chromium', 'signed playback', 'PCI gap', 'human publish'],
    command: [pnpm, '--filter', '@d-contact/console', 'test:e2e'],
    remediation: 'ตรวจ Console OIDC root, API context และ QM publish flow',
  },
];

export function phaseTwoSummary(diagnostics, startedAt = new Date()) {
  const failed = diagnostics.filter(({ status }) => status === 'FAIL');
  return {
    type: 'readiness.summary',
    workflow: 'inbound-voice-phase-2-acceptance',
    workflowVersion: 1,
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: diagnostics.filter(({ status }) => status === 'PASS').length,
    failed: failed.length,
    skipped: diagnostics.filter(({ status }) => status === 'SKIP').length,
    entryCondition: failed.length === 0 ? 'INBOUND_VOICE_PHASE_2_PILOT_READY' : 'NOT_READY',
    evidenceScope: 'development acceptance baseline; not a production SLA',
  };
}

export function runPhaseTwoReadiness() {
  const startedAt = new Date();
  const diagnostics = [];
  let blocker;
  for (const check of PHASE_TWO_READINESS_CHECKS) {
    const diagnostic = blocker ? skippedDiagnostic(check, blocker) : executeReadinessCheck(check);
    diagnostics.push(diagnostic);
    process.stdout.write(`${JSON.stringify({ type: 'readiness.check', ...diagnostic })}\n`);
    if (diagnostic.status === 'FAIL') blocker = diagnostic.checkId;
  }
  const summary = phaseTwoSummary(diagnostics, startedAt);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const summary = runPhaseTwoReadiness();
  if (summary.status === 'FAIL') process.exitCode = 1;
}
