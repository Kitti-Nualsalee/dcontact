import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { classifyPaths, detectImpact, suites } from './ci-impact.mjs';

const enabled = (result) => suites.filter((suite) => result[suite]);

test('docs, frontend and isolated Customer 360 tests leave the four external seams idle', () => {
  assert.deepEqual(
    enabled(
      classifyPaths([
        'docs/agents/work-stage.md',
        'AGENTS.md',
        'apps/api/CONTEXT.md',
        'apps/console/src/core-settings/teams-page.tsx',
        'apps/workspace/src/agent-workspace.tsx',
        'packages/ui/src/tokens.css',
        'packages/ui-react/src/button.tsx',
        'packages/i18n/src/catalog.ts',
        'apps/api/src/customer-360-work.integration.ts',
        'apps/api/src/customer-overview.test.ts',
        'apps/api/scripts/cus360-c5-component-sandbox.mjs',
      ]),
    ),
    [],
  );
});

test('routing and telephony changes exercise real SIP and voice integration', () => {
  for (const path of [
    'apps/router/src/managed-voice-runtime.ts',
    'apps/telephony/src/managed-voice-adapter.ts',
  ])
    assert.deepEqual(enabled(classifyPaths([path])), ['managed', 'voice'], path);
});

test('API identity, Team writers and their application dependencies keep boundary coverage', () => {
  for (const path of [
    'apps/api/src/gateway-auth.ts',
    'apps/api/src/tenant-core-command.ts',
    'apps/api/src/tenant-people-provisioning.ts',
    'apps/api/src/customer-360-work.ts',
    'apps/journey/src/enrollment.ts',
    'apps/dialer/src/campaign.ts',
    'apps/customer-360/src/customer.ts',
  ])
    assert.deepEqual(enabled(classifyPaths([path])), ['core', 'people', 'voice'], path);
});

test('DB, IAM, contracts, runtime dependencies and CI infrastructure never lose coverage', () => {
  for (const path of [
    'packages/db/prisma/rls.sql',
    'packages/db/prisma/migrations/20261109000000_change/migration.sql',
    'packages/iam/src/authorization.ts',
    'packages/shared/src/voice.ts',
    'packages/cxa-contracts/src/index.ts',
    'packages/workspace-session/src/index.ts',
    'apps/contact-governance/src/policy.ts',
    'apps/delivery/src/voice-originate-dispatcher.ts',
    'scripts/core-settings-writer-cases.json',
    'scripts/tenant_people_disable_boundary.py',
    'scripts/ci-impact.mjs',
    'infra/keycloak/extensions/invitation-guard/pom.xml',
    '.github/workflows/ci.yml',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    'tsconfig.base.json',
    'apps/new-runtime/src/index.ts',
  ])
    assert.deepEqual(enabled(classifyPaths([path])), suites, path);
});

test('mixed diffs take the union; Console toolchain keeps the real onboarding browser', () => {
  assert.deepEqual(enabled(classifyPaths(['apps/console/package.json'])), ['people']);
  assert.deepEqual(
    enabled(classifyPaths(['apps/api/src/gateway-auth.ts', 'apps/router/src/routing.ts'])),
    suites,
  );
});

test('manual integration/all run every suite while unit and ADR-032 chain stay independent', () => {
  for (const acceptance of ['integration', 'all', 'unit', 'chain', 'j2']) {
    const result = detectImpact({
      env: { GITHUB_EVENT_NAME: 'workflow_dispatch', ACCEPTANCE: acceptance },
    });
    assert.deepEqual(
      enabled(result.affected),
      ['integration', 'all'].includes(acceptance) ? suites : [],
    );
  }
});

test('invalid, missing and unavailable bases fail safe instead of suppressing integration', () => {
  for (const base of [
    undefined,
    '',
    '0'.repeat(40),
    '--output=unsafe',
    '$(echo unsafe)',
    'a'.repeat(40),
  ]) {
    const result = detectImpact({ env: { BASE_SHA: base }, cwd: tmpdir() });
    assert.equal(result.reason, 'fallback-all');
    assert.deepEqual(enabled(result.affected), suites);
  }
});

test('real git diff covers deleted and renamed old paths with NUL-safe filenames', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dcontact-ci-impact-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const write = (path) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), 'fixture\n');
  };
  try {
    git('init', '-q');
    git('config', 'user.email', 'ci-impact@example.invalid');
    git('config', 'user.name', 'CI Impact');
    write('apps/router/src/managed-runtime.ts');
    write('docs/old.md');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    assert.deepEqual(enabled(detectImpact({ env: { BASE_SHA: base }, cwd }).affected), []);

    mkdirSync(join(cwd, 'docs'), { recursive: true });
    git('mv', 'apps/router/src/managed-runtime.ts', 'docs/moved.md');
    git('rm', '-q', 'docs/old.md');
    write('docs/unusual\nfilename.md');
    git('add', '.');
    git('commit', '-qm', 'rename runtime to docs');
    const result = detectImpact({ env: { BASE_SHA: base }, cwd });
    assert.equal(result.reason, 'diff');
    assert.ok(result.paths.includes('apps/router/src/managed-runtime.ts'));
    assert.ok(result.paths.includes('docs/unusual\nfilename.md'));
    assert.deepEqual(enabled(result.affected), ['managed', 'voice']);

    const future = git('rev-parse', 'HEAD');
    git('checkout', '-q', base);
    assert.equal(detectImpact({ env: { BASE_SHA: future }, cwd }).reason, 'fallback-all');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
