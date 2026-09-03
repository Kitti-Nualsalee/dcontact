import { execFileSync } from 'node:child_process';

const composeArguments = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];
const runningServices = ['postgres', 'redis', 'minio', 'redpanda', 'freeswitch'];
const requiredTopics = [
  'dc.telephony.events',
  'dc.channel.events',
  'dc.interaction.events',
  'dc.agent.events',
  'dc.telephony.commands',
  'dc.channel.commands',
  'dc.journey.events',
];

function compose(...arguments_) {
  return execFileSync('docker', [...composeArguments, ...arguments_], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

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

check('Docker services ทำงานอยู่', () => {
  const active = new Set(
    compose('ps', '--services', '--status', 'running').split(/\s+/).filter(Boolean),
  );
  const missing = runningServices.filter((service) => !active.has(service));
  assert(missing.length === 0, `ยังไม่พร้อม: ${missing.join(', ')}. รัน pnpm infra:up แล้วลองใหม่`);
});

check('PostgreSQL รับการเชื่อมต่อได้', () =>
  compose('exec', '-T', 'postgres', 'pg_isready', '-U', 'dcontact'),
);
check('PostgreSQL มี tenant baseline ของ Phase 0', () => {
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
  assert(demoTenantCount === '1', 'ไม่พบ tenant baseline ชื่อ demo; รัน pnpm infra:bootstrap');
  assert(Number(rlsPolicyCount) > 0, 'ไม่พบ RLS policy; รัน pnpm infra:bootstrap');
});
check('Redis พร้อมเป็น state store', () => {
  const reply = compose('exec', '-T', 'redis', 'redis-cli', 'ping');
  assert(reply === 'PONG', `expected PONG, got ${reply || '(empty)'}`);
});
check('MinIO live endpoint ตอบสนอง', () =>
  compose('exec', '-T', 'minio', 'sh', '-c', 'curl -fsS http://localhost:9000/minio/health/live'),
);
check('bucket recordings พร้อมใช้งาน', () => compose('run', '--rm', '--no-deps', 'minio-init'));
check('Redpanda cluster มีสุขภาพดี', () =>
  compose('exec', '-T', 'redpanda', 'rpk', 'cluster', 'health'),
);
check('Redpanda มี topic ตาม contract', () => {
  const topics = new Set(
    compose('exec', '-T', 'redpanda', 'rpk', 'topic', 'list', '--brokers', 'redpanda:29092').split(
      /\s+/,
    ),
  );
  const missing = requiredTopics.filter((topic) => !topics.has(topic));
  assert(missing.length === 0, `topics ที่หายไป: ${missing.join(', ')}`);
  assert(!topics.has('dc.fs.events'), 'พบ topic ที่เลิกใช้แล้ว: dc.fs.events');
});
check('FreeSWITCH พร้อมสำหรับ ESL, SIP และ WebSocket ใน dev', () => {
  compose('exec', '-T', 'freeswitch', 'fs_cli', '-x', 'status');
  const profile = compose(
    'exec',
    '-T',
    'freeswitch',
    'fs_cli',
    '-x',
    'sofia status profile internal',
  );
  assert(profile.includes('BIND-URL'), 'FreeSWITCH internal SIP profile ไม่พร้อม');
  assert(profile.includes('WS-BIND-URL'), 'FreeSWITCH WebSocket SIP profile ไม่พร้อม');
  assert(profile.includes('Ext-RTP-IP'), 'FreeSWITCH RTP configuration ไม่พร้อม');
});

if (process.exitCode) {
  console.error('\nPhase 0 dev foundation ยังไม่พร้อม');
} else {
  console.log('\nPhase 0 dev foundation พร้อมใช้งาน');
}
