import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// แยกจาก whole-slice/VM UAT: ทุก suite ใช้ PostgreSQL จริงและ app principal ตาม environment
const suites = [
  ['@d-contact/db', null, ['src/team-reference-guards.integration.ts']],
  [
    '@d-contact/api',
    null,
    [
      'src/tenant-core-teams.integration.ts',
      'src/tenant-core-team-people.integration.ts',
      'src/tenant-core-team-writers.integration.ts',
    ],
  ],
  [
    '@d-contact/iam',
    'Core Team fence',
    [
      'src/team-segment-scope-repository.integration.ts',
      'src/team-authoring-reference.integration.ts',
    ],
  ],
  [
    '@d-contact/contact-governance',
    'Core Team fence',
    [
      'src/authorize-and-reserve.integration.ts',
      'src/cg5-alert-repository.integration.ts',
      'src/reservation-runtime.integration.ts',
    ],
  ],
  [
    '@d-contact/dialer',
    'Core Team fence',
    [
      'src/dialer-admit-campaign-target-service.integration.ts',
      'src/dialer-callback-service.integration.ts',
      'src/dialer-originate-barrier.integration.ts',
      'src/dialer-originate-reconciler.integration.ts',
    ],
  ],
  [
    '@d-contact/journey',
    'Core Team fence|Team writers',
    [
      'src/team-reference-writers.integration.ts',
      'src/journey-authoring-repository.integration.ts',
      'src/journey-template-repository.integration.ts',
      'src/journey-execution.integration.ts',
      'src/journey-outcome-trigger-processor.integration.ts',
      'src/journey-segment-trigger-processor.integration.ts',
      'src/journey-segment-refilter-processor.integration.ts',
      'src/journey-owner-action-repository.integration.ts',
      'src/journey-owner-continuation.integration.ts',
      'src/journey-owner-command-relay.integration.ts',
      'src/journey-processor.integration.ts',
      'src/journey-governance-invalidation.integration.ts',
      'src/journey-segment-receipt-repository.integration.ts',
      'src/journey-send-executor.integration.ts',
    ],
  ],
];
for (const [pkg, pattern, files] of suites) {
  const args = [
    '--filter',
    pkg,
    'exec',
    'tsx',
    '--test',
    '--test-concurrency=1',
    '--test-timeout=30000',
    ...(pattern ? [`--test-name-pattern=${pattern}`] : []),
    ...files,
  ];
  process.stdout.write(`\n# Core Settings writer suite: ${pkg}\n`);
  const result = spawnSync('pnpm', args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0 || !/^# pass [1-9][0-9]*$/m.test(result.stdout ?? '')) {
    process.stderr.write(`Core Settings writer suite ไม่ผ่านหรือไม่พบ test: ${pkg}\n`);
    process.exit(result.status || 1);
  }
}
process.stdout.write('\n# Core Settings writer suites: PASS 6/6; ไม่ใช่ VM UAT signoff\n');
