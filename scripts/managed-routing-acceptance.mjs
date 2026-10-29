import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, statfsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = `managed-${randomUUID().slice(0, 8)}`;
const evidence = mkdtempSync(resolve(tmpdir(), `${prefix}-`));
const network = `${prefix}-net`;
const containers = [];
const sipp = 'ctaloi/sipp@sha256:c459f2340443ddcc159227efc798217dbdaad0dbe88b76b78b1a876aa271986a';
const images = [
  'postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea',
  'safarov/freeswitch@sha256:f156e01a96d48944078ed7f0e24304be63ea15f6466cf607a0aeb6cb47761da7',
  sipp,
];
const environment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=768' };
const proofSources = [
  'apps/router/src/managed-voice-runtime.ts',
  'apps/router/src/managed-voice-contracts.ts',
  'apps/telephony/src/managed-voice-adapter.ts',
  'apps/telephony/src/managed-voice-events.ts',
  'apps/telephony/src/e1-esl-command-client.ts',
  'apps/router/scripts/managed-routing-runner.mts',
  'scripts/managed-routing-acceptance.mjs',
  'scripts/fixtures/managed-freeswitch.xml',
  'scripts/fixtures/managed-caller.xml',
  'scripts/fixtures/managed-ringing.xml',
  'scripts/fixtures/managed-answer.xml',
  'scripts/fixtures/managed-caller-hangup.xml',
  'packages/db/prisma/schema.prisma',
  'packages/db/prisma/rls.sql',
  'packages/db/prisma/migrations/20261024120000_voice_managed_runtime/migration.sql',
];
const sourceDigests = () =>
  Object.fromEntries(
    proofSources.map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(resolve(root, path)))
        .digest('hex'),
    ]),
  );
let runner;
let cleaned = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')}\n${result.error ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  return result.stdout.trim();
}

const docker = (...args) => run('docker', args);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function ready(check, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch {}
    await wait(500);
  }
  throw new Error(`${label} ไม่พร้อมภายใน 60s`);
}
function container(name, memory, args) {
  containers.push(name);
  return docker(
    'run',
    '-d',
    '--name',
    name,
    '--network',
    network,
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--cpus',
    '1',
    '--pids-limit',
    '128',
    '--log-opt',
    'max-size=5m',
    '--log-opt',
    'max-file=1',
    ...args,
  );
}
function mapped(name, port) {
  const value = docker('port', name, `${port}/tcp`);
  if (!/^127\.0\.0\.1:\d+$/.test(value)) throw new Error(`port mapping ผิด: ${value}`);
  return Number(value.split(':')[1]);
}
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (runner?.exitCode === null) {
    try {
      process.kill(-runner.pid, 'SIGTERM');
    } catch {}
    await wait(500);
    try {
      process.kill(-runner.pid, 'SIGKILL');
    } catch {}
  }
  const inventory = spawnSync(
    'docker',
    ['ps', '-a', '--filter', `name=^${prefix}-`, '--format', '{{.Names}}'],
    { encoding: 'utf8', timeout: 10000 },
  );
  const owned = new Set([
    ...containers,
    ...(inventory.stdout ?? '').trim().split('\n').filter(Boolean),
  ]);
  for (const name of [...owned].toReversed()) {
    const log = spawnSync('docker', ['logs', name], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    });
    writeFileSync(resolve(evidence, `${name}.log`), `${log.stdout ?? ''}${log.stderr ?? ''}`);
    spawnSync('docker', ['rm', '-f', name], { timeout: 15000, stdio: 'ignore' });
  }
  spawnSync('docker', ['network', 'rm', network], { timeout: 15000, stdio: 'ignore' });
}
process.once('SIGINT', () => void cleanup().finally(() => process.exit(130)));
process.once('SIGTERM', () => void cleanup().finally(() => process.exit(143)));

try {
  const disk = statfsSync(evidence);
  if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw new Error('ต้องมี disk ว่างอย่างน้อย 2GiB');
  const memory = Number(docker('info', '--format', '{{.MemTotal}}'));
  if (memory < 3 * 1024 ** 3) throw new Error('Docker ต้องมี memory อย่างน้อย 3GiB');
  for (const image of images) docker('image', 'inspect', image);
  docker('network', 'create', network);
  const postgres = `${prefix}-pg`;
  const freeswitch = `${prefix}-fs`;
  container(postgres, '768m', [
    '--tmpfs',
    '/var/lib/postgresql/data:rw,size=768m',
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_PASSWORD=managed-local-only',
    '-e',
    'POSTGRES_USER=dcontact',
    '-e',
    'POSTGRES_DB=dcontact_managed_acceptance',
    images[0],
  ]);
  await ready(
    () => docker('exec', postgres, 'pg_isready', '-U', 'dcontact').includes('accepting'),
    'PostgreSQL',
  );
  const databaseUrl = `postgresql://dcontact:managed-local-only@127.0.0.1:${mapped(postgres, 5432)}/dcontact_managed_acceptance?schema=public`;
  environment.DATABASE_URL = databaseUrl;
  environment.APPLICATION_DATABASE_URL = databaseUrl.replace(
    'dcontact:managed-local-only@',
    'dcontact_app:dcontact_app@',
  );
  run('pnpm', ['db:migrate']);
  run('pnpm', ['db:rls']);
  const config = resolve(root, 'scripts/fixtures/managed-freeswitch.xml');
  container(freeswitch, '768m', [
    '--network-alias',
    'freeswitch',
    '-p',
    '127.0.0.1::8021',
    '-v',
    `${config}:/etc/freeswitch/freeswitch.xml:ro`,
    images[1],
  ]);
  await ready(
    () =>
      docker('exec', freeswitch, 'fs_cli', '-p', 'managed-local-only', '-x', 'sofia status').match(
        /managed\s+profile[^\n]*RUNNING/,
      ) !== null,
    'FreeSWITCH',
  );
  for (const index of [1, 2, 3]) {
    container(`${prefix}-agent${index}`, '96m', [
      '--network-alias',
      `agent${index}`,
      '-v',
      `${resolve(root, 'scripts/fixtures')}:/fixtures:ro`,
      '-v',
      `${evidence}:/evidence`,
      '--entrypoint',
      'sh',
      sipp,
      '-c',
      `cd /evidence && exec sipp -sf /fixtures/managed-ringing.xml -i $(hostname -i) -p 5060 -nostdin -trace_msg -trace_err -message_file agent${index}-messages.log -error_file agent${index}-errors.log`,
    ]);
  }
  environment.MANAGED_EVIDENCE = evidence;
  environment.MANAGED_PREFIX = prefix;
  environment.MANAGED_NETWORK = network;
  environment.MANAGED_FS_CONTAINER = freeswitch;
  environment.MANAGED_ESL_PORT = String(mapped(freeswitch, 8021));
  environment.MANAGED_SIPP_IMAGE = sipp;
  writeFileSync(
    resolve(evidence, 'environment.json'),
    JSON.stringify(
      {
        run: prefix,
        revision: run('git', ['rev-parse', 'HEAD']),
        memoryLimitMiB: 2208,
        diskAvailableBytes: disk.bavail * disk.bsize,
        images: images.map((image) => JSON.parse(docker('image', 'inspect', image))[0].Id),
        databasePort: mapped(postgres, 5432),
        eslPort: mapped(freeswitch, 8021),
        dependencies: ['PostgreSQL', 'FreeSWITCH', 'SIPp'],
      },
      null,
      2,
    ),
  );
  console.log(`หลักฐาน: ${evidence}`);
  const beforeSources = sourceDigests();
  writeFileSync(resolve(evidence, 'sources.json'), JSON.stringify(beforeSources, null, 2));
  runner = spawn(
    'pnpm',
    ['--filter', '@d-contact/router', 'exec', 'tsx', 'scripts/managed-routing-runner.mts'],
    { cwd: root, env: environment, stdio: 'inherit', detached: true },
  );
  const timeout = setTimeout(() => {
    try {
      process.kill(-runner.pid, 'SIGTERM');
    } catch {}
  }, 240000);
  const code = await new Promise((done, reject) => {
    runner.once('error', reject);
    runner.once('exit', done);
  });
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`managed SIP acceptance runner exit ${code}`);
  if (JSON.stringify(sourceDigests()) !== JSON.stringify(beforeSources))
    throw new Error('source เปลี่ยนระหว่าง run ต้องรัน proof ใหม่');
  const result = JSON.parse(readFileSync(resolve(evidence, 'result.json'), 'utf8'));
  const requiredCases = [
    'twoAgents-noanswer20s-skip-next',
    'blocked-dispatch-A-does-not-stop-B-deadline',
    'restart-after-DBcommit-before-dispatch-actual-caller-and-Bleg',
    'total60s-real-caller-hangup-no-repeat',
    'noeligible-total60s-real-hangup',
    'late-real-answer-fenced-ACTIVE-survives60s',
    'active-restart-missed-hangup-real-caller-BYE-wrapup',
  ];
  if (
    result.status !== 'PASS' ||
    !Array.isArray(result.cases) ||
    requiredCases.some((name) => result.cases.filter((item) => item.name === name).length !== 1)
  )
    throw new Error('ไม่มีหลักฐานครบจาก runner');
  console.log(`MANAGED_ROUTING_ACCEPTANCE_PASS ${evidence}`);
} catch (error) {
  process.exitCode = 1;
  writeFileSync(
    resolve(evidence, 'failure.json'),
    JSON.stringify({ status: 'FAIL', error: String(error) }, null, 2),
  );
  console.error(error);
  console.error(`MANAGED_ROUTING_ACCEPTANCE_FAIL หลักฐาน: ${evidence}`);
} finally {
  await cleanup();
}
