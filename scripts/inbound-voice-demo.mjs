import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const compose = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];
const sippImage =
  'ctaloi/sipp@sha256:c459f2340443ddcc159227efc798217dbdaad0dbe88b76b78b1a876aa271986a';
const agentContainer = `dcontact-sipp-agent-${process.pid}`;
const nodeId = `fs-demo-${process.pid}`;
const children = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: process.cwd(), encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} ล้มเหลว\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  children.push(child);
  return child;
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function cleanup() {
  for (const child of children) child.kill('SIGTERM');
  spawnSync('docker', ['rm', '-f', agentContainer], { stdio: 'ignore' });
}

try {
  run('docker', [...compose, 'ps', '--status', 'running']);
  run('docker', ['pull', sippImage]);
  run('pnpm', ['db:seed']);
  run('docker', [...compose, 'exec', '-T', 'freeswitch', 'fs_cli', '-x', 'reloadxml']);

  start('pnpm', ['--filter', '@d-contact/router', 'dev']);
  start('pnpm', ['--filter', '@d-contact/telephony', 'dev'], {
    env: {
      ...process.env,
      TELEPHONY_NODE_ID: nodeId,
      FREESWITCH_AGENT_DIAL_TEMPLATE: `sofia/internal/{extension}@${agentContainer}:5060`,
    },
  });
  start('docker', [
    'run',
    '--rm',
    '--name',
    agentContainer,
    '--network',
    'd-contact-dev_default',
    '--entrypoint',
    'sh',
    sippImage,
    '-c',
    'exec sipp -sn uas -i $(hostname -i) -p 5060 -nostdin -trace_err',
  ]);
  await wait(3_000);

  const fixture = resolve('scripts/fixtures/inbound-voice-uac.xml');
  const callerProcess = start('docker', [
    'run',
    '--rm',
    '--network',
    'd-contact-dev_default',
    '-v',
    `${fixture}:/scenario.xml:ro`,
    sippImage,
    'freeswitch:5060',
    '-sf',
    '/scenario.xml',
    '-cid_str',
    `dcontact-demo-${process.pid}-%u@%s`,
    '-m',
    '1',
    '-timeout',
    '15s',
    '-timeout_error',
    '-nostdin',
    '-trace_err',
  ]);
  let caller = '';
  callerProcess.stdout.on('data', (chunk) => (caller += chunk.toString()));
  callerProcess.stderr.on('data', (chunk) => (caller += chunk.toString()));
  await wait(1_500);
  const media = JSON.parse(
    run('docker', [
      ...compose,
      'exec',
      '-T',
      'freeswitch',
      'fs_cli',
      '-x',
      'show channels as json',
    ]),
  );
  const activeMediaLegs = media.rows.filter(
    (row) => row.callstate === 'ACTIVE' && row.read_codec === 'PCMU' && row.write_codec === 'PCMU',
  );
  if (activeMediaLegs.length < 2) {
    throw new Error(`FreeSWITCH ไม่ยืนยัน media สอง leg: ${JSON.stringify(media)}`);
  }
  const callerExit = await new Promise((resolveExit) =>
    callerProcess.once('close', (code) => resolveExit(code)),
  );
  if (callerExit !== 0) throw new Error(`SIPp caller ล้มเหลว\n${caller}`);
  if (!caller.includes('Successful call') || !caller.match(/Successful call\s+\|\s+0\s+\|\s+1/)) {
    throw new Error(`SIPp ไม่ยืนยัน successful media call\n${caller}`);
  }
  await wait(1_000);

  const evidence = run('docker', [
    ...compose,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'dcontact',
    '-d',
    'dcontact',
    '-Atc',
    `SELECT i.state || '|' || (i.metadata->>'telephonyNodeId') || '|' || count(e.id)
     FROM interactions i JOIN interaction_events e ON e.interaction_id=i.id
     WHERE i.tenant_id=(SELECT id FROM tenants WHERE slug='demo')
     GROUP BY i.id ORDER BY i.queued_at DESC LIMIT 1`,
  ]).trim();
  if (evidence !== `ACTIVE|${nodeId}|4`) {
    throw new Error(`หลักฐาน lifecycle ไม่ครบ: ${evidence || 'ไม่พบ interaction'}`);
  }
  console.log(`INBOUND_VOICE_PHASE_1_DEMO_PASS ${evidence}`);
} finally {
  await cleanup();
}
