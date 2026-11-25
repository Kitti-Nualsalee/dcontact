import { readFileSync } from 'node:fs';
import { compose } from './dev-infra-compose.mjs';
import { DEV_BUCKETS, missingBuckets } from './object-storage-readiness.mjs';
const runningServices = [
  'postgres',
  'redis',
  'object-storage',
  'redpanda',
  'freeswitch',
  'keycloak',
];
// derived from KAFKA_TOPICS in packages/shared (the single source of truth) instead of a duplicated list here -
// the old list drifted until new topics were missing from the bootstrapped env without anyone knowing, and the consumer tests hung until timeout
const kafkaTopicSource = readFileSync(
  new URL('../packages/shared/src/events.ts', import.meta.url),
  'utf8',
);
const requiredTopics = [
  ...kafkaTopicSource
    .slice(kafkaTopicSource.indexOf('export const KAFKA_TOPICS'))
    .split('} as const')[0]
    .matchAll(/'(dc\.[a-z0-9.-]+)'/g),
].map(([, topic]) => topic);

function check(name, action) {
  try {
    action();
    console.log(`✓ ${name}`);
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    console.error(`✗ ${name}: ${detail}`);
    process.exitCode = 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

check('Docker services are running', () => {
  const active = new Set(
    compose('ps', '--services', '--status', 'running').split(/\s+/).filter(Boolean),
  );
  const missing = runningServices.filter((service) => !active.has(service));
  assert(missing.length === 0, `not ready: ${missing.join(', ')}. Run pnpm infra:up and try again`);
});

check('PostgreSQL accepts connections', () =>
  compose('exec', '-T', 'postgres', 'pg_isready', '-U', 'dcontact'),
);
check('PostgreSQL has the Phase 0 tenant baseline', () => {
  const [demoTenantCount, rlsPolicyCount] = compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'dcontact',
    '-d',
    'dcontact',
    '-tAc',
    "SELECT (SELECT count(*) FROM tenants WHERE slug = 'demo'), (SELECT count(*) FROM pg_policies WHERE policyname = 'tenant_isolation');",
  ).split('|');
  assert(demoTenantCount === '1', 'tenant baseline named demo not found; run pnpm infra:bootstrap');
  assert(Number(rlsPolicyCount) > 0, 'no RLS policy found; run pnpm infra:bootstrap');
});
check('Redis is ready as a state store', () => {
  const reply = compose('exec', '-T', 'redis', 'redis-cli', 'ping');
  assert(reply === 'PONG', `expected PONG, got ${reply || '(empty)'}`);
});
// ADR-029: checked through the S3 API (HeadBucket), so it does not depend on the storage vendor
try {
  const missing = await missingBuckets();
  assert(
    missing.length === 0,
    `buckets that are unusable: ${missing.join(', ')}. Run pnpm infra:up`,
  );
  console.log(`✓ Object storage has buckets ${DEV_BUCKETS.join(', ')}`);
} catch (error) {
  console.error(`✗ Object storage has buckets ${DEV_BUCKETS.join(', ')}: ${error.message}`);
  process.exitCode = 1;
}
check('Redpanda cluster is healthy', () =>
  compose('exec', '-T', 'redpanda', 'rpk', 'cluster', 'health'),
);
check('Redpanda has the topics per the contract', () => {
  const topics = new Set(
    compose('exec', '-T', 'redpanda', 'rpk', 'topic', 'list', '--brokers', 'redpanda:29092').split(
      /\s+/,
    ),
  );
  const missing = requiredTopics.filter((topic) => !topics.has(topic));
  assert(missing.length === 0, `missing topics: ${missing.join(', ')}`);
  assert(!topics.has('dc.fs.events'), 'found a retired topic: dc.fs.events');
});
check('FreeSWITCH is ready for ESL, SIP and WebSocket in dev', () => {
  compose('exec', '-T', 'freeswitch', 'fs_cli', '-x', 'status');
  const profile = compose(
    'exec',
    '-T',
    'freeswitch',
    'fs_cli',
    '-x',
    'sofia status profile internal',
  );
  assert(profile.includes('BIND-URL'), 'FreeSWITCH internal SIP profile is not ready');
  assert(profile.includes('WS-BIND-URL'), 'FreeSWITCH WebSocket SIP profile is not ready');
  assert(profile.includes('Ext-RTP-IP'), 'FreeSWITCH RTP configuration is not ready');
});

if (process.exitCode) {
  console.error('\nPhase 0 dev foundation is not ready');
} else {
  console.log('\nPhase 0 dev foundation is ready to use');
}
