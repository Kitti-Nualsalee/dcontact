// #1061 agent callback against real FreeSWITCH and SIPp; same sandbox as scripts/managed-routing-acceptance.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, statfsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = `callback-${randomUUID().slice(0, 8)}`;
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
  'apps/router/src/managed-callback.ts',
  'apps/router/src/managed-voice-runtime.ts',
  'apps/router/src/managed-voice-contracts.ts',
  'apps/telephony/src/managed-voice-adapter.ts',
  'apps/telephony/src/managed-voice-events.ts',
  'apps/router/scripts/callback-runner.mts',
  'scripts/callback-acceptance.mjs',
  'scripts/fixtures/callback-freeswitch.xml',
  'scripts/fixtures/callback-customer.xml',
  'scripts/fixtures/callback-busy.xml',
  'scripts/fixtures/managed-answer.xml',
  'scripts/fixtures/managed-ringing.xml',
  'packages/db/prisma/migrations/20261129090000_agent_callbacks_round_one/migration.sql',
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
  throw new Error(`${label} was not ready within 60s`);
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
    // Docker Desktop may enable log compression by default, which a single log file cannot use
    '--log-opt',
    'compress=false',
    ...args,
  );
}
function mapped(name, port) {
  const value = docker('port', name, `${port}/tcp`);
  if (!/^127\.0\.0\.1:\d+$/.test(value)) throw new Error(`wrong port mapping: ${value}`);
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
  if (disk.bavail * disk.bsize < 2 * 1024 ** 3)
    throw new Error('at least 2GiB of free disk is required');
  const memory = Number(docker('info', '--format', '{{.MemTotal}}'));
  if (memory < 3 * 1024 ** 3) throw new Error('Docker must have at least 3GiB of memory');
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
    'POSTGRES_DB=dcontact_callback_acceptance',
    images[0],
  ]);
  await ready(
    () => docker('exec', postgres, 'pg_isready', '-U', 'dcontact').includes('accepting'),
    'PostgreSQL',
  );
  const databaseUrl = `postgresql://dcontact:managed-local-only@127.0.0.1:${mapped(postgres, 5432)}/dcontact_callback_acceptance?schema=public`;
  environment.DATABASE_URL = databaseUrl;
  environment.APPLICATION_DATABASE_URL = databaseUrl.replace(
    'dcontact:managed-local-only@',
    'dcontact_app:dcontact_app@',
  );
  run('pnpm', ['db:migrate']);
  run('pnpm', ['db:rls']);
  const config = resolve(root, 'scripts/fixtures/callback-freeswitch.xml');
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
  // agent1 and agent3 answer at once (Workspace answers D-Phone for the Agent), agent2 only rings;
  // customer1 answers and hangs up after 3 seconds, customer2 is busy
  for (const [alias, scenario] of [
    ['agent1', 'managed-answer.xml'],
    ['agent2', 'managed-ringing.xml'],
    ['agent3', 'managed-answer.xml'],
    ['customer1', 'callback-customer.xml'],
    ['customer2', 'callback-busy.xml'],
  ]) {
    container(`${prefix}-${alias}`, '96m', [
      '--network-alias',
      alias,
      '-v',
      `${resolve(root, 'scripts/fixtures')}:/fixtures:ro`,
      '-v',
      `${evidence}:/evidence`,
      '--entrypoint',
      'sh',
      sipp,
      '-c',
      `cd /evidence && exec sipp -sf /fixtures/${scenario} -i $(hostname -i) -p 5060 -nostdin -trace_msg -trace_err -message_file ${alias}-messages.log -error_file ${alias}-errors.log`,
    ]);
  }
  environment.CALLBACK_EVIDENCE = evidence;
  environment.CALLBACK_ESL_PORT = String(mapped(freeswitch, 8021));
  writeFileSync(
    resolve(evidence, 'environment.json'),
    JSON.stringify(
      {
        run: prefix,
        revision: run('git', ['rev-parse', 'HEAD']),
        memoryLimitMiB: 2016,
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
  console.log(`evidence: ${evidence}`);
  const beforeSources = sourceDigests();
  writeFileSync(resolve(evidence, 'sources.json'), JSON.stringify(beforeSources, null, 2));
  runner = spawn(
    'pnpm',
    ['--filter', '@d-contact/router', 'exec', 'tsx', 'scripts/callback-runner.mts'],
    { cwd: root, env: environment, stdio: 'inherit', detached: true },
  );
  const timeout = setTimeout(() => {
    try {
      process.kill(-runner.pid, 'SIGTERM');
    } catch {}
  }, 180000);
  const code = await new Promise((done, reject) => {
    runner.once('error', reject);
    runner.once('exit', done);
  });
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`callback SIP acceptance runner exit ${code}`);
  if (JSON.stringify(sourceDigests()) !== JSON.stringify(beforeSources))
    throw new Error('the source changed during the run; the proof must be re-run');
  const result = JSON.parse(readFileSync(resolve(evidence, 'result.json'), 'utf8'));
  const requiredCases = [
    'agent-answers-customer-answers-and-hangs-up',
    'agent-answers-customer-busy-wrapup',
    'agent-no-answer-abandoned-not-reoffered',
  ];
  if (
    result.status !== 'PASS' ||
    !Array.isArray(result.cases) ||
    requiredCases.some((name) => result.cases.filter((item) => item.name === name).length !== 1)
  )
    throw new Error('the runner did not give complete evidence');
  console.log(`CALLBACK_ACCEPTANCE_PASS ${evidence}`);
} catch (error) {
  process.exitCode = 1;
  writeFileSync(
    resolve(evidence, 'failure.json'),
    JSON.stringify({ status: 'FAIL', error: String(error) }, null, 2),
  );
  console.error(error);
  console.error(`CALLBACK_ACCEPTANCE_FAIL evidence: ${evidence}`);
} finally {
  await cleanup();
}
