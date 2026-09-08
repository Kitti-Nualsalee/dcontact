import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const compose = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];
const sippImage =
  'ctaloi/sipp@sha256:c459f2340443ddcc159227efc798217dbdaad0dbe88b76b78b1a876aa271986a';
const agentContainer = `dcontact-sipp-agent-${process.pid}`;
const nodeId = `fs-demo-${process.pid}`;
const routerGroupId = `dcontact-router-demo-${process.pid}`;
const children = [];
const ivrDtmf = process.env.INBOUND_DEMO_DTMF;

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
  const { diagnostic, ...spawnOptions } = options;
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    ...spawnOptions,
  });
  if (diagnostic) {
    child.stderr.on('data', (chunk) => process.stderr.write(`[${diagnostic}] ${chunk}`));
  }
  children.push(child);
  return child;
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function waitForConsumerGroup(groupId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync(
      'docker',
      [...compose, 'exec', '-T', 'redpanda', 'rpk', 'group', 'describe', groupId],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    if (
      result.status === 0 &&
      /STATE\s+Stable/.test(result.stdout) &&
      /MEMBERS\s+1/.test(result.stdout)
    ) {
      return;
    }
    await wait(500);
  }
  throw new Error(`consumer group ยังไม่พร้อม: ${groupId}`);
}

function resetPreviousDemoInteractions() {
  run('docker', [
    ...compose,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'dcontact',
    '-d',
    'dcontact',
    '-c',
    `UPDATE interactions
     SET state = 'ABANDONED', ended_at = NOW(), offer_expires_at = NULL, requeue_at = NULL
     WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'demo')
       AND metadata->>'telephonyNodeId' LIKE 'fs-demo-%'
       AND state IN ('QUEUED', 'ASSIGNED', 'ACTIVE', 'WRAPUP');`,
  ]);
}

function resetPreviousDemoMedia() {
  const channels = JSON.parse(
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
  for (const channel of channels.rows ?? []) {
    if (channel.initial_dest === '2000' || channel.initial_dest === '2001') {
      run('docker', [
        ...compose,
        'exec',
        '-T',
        'freeswitch',
        'fs_cli',
        '-x',
        `uuid_kill ${channel.uuid} NORMAL_CLEARING`,
      ]);
    }
  }
}

function latestDemoEvidence() {
  return run('docker', [
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
    `SELECT concat_ws('|', i.tenant_id, i.id, i.agent_id, i.state,
       i.metadata->>'telephonyNodeId', count(DISTINCT e.id),
       coalesce(r.id::text, ''), coalesce(r.duration_sec::text, ''),
       CASE WHEN r.archived_at IS NULL THEN 'OPEN' ELSE 'ARCHIVED' END)
     FROM interactions i
     LEFT JOIN interaction_events e ON e.interaction_id=i.id
     LEFT JOIN recordings r ON r.interaction_id=i.id
     WHERE i.tenant_id=(SELECT id FROM tenants WHERE slug='demo')
       AND i.metadata->>'telephonyNodeId'='${nodeId}'
     GROUP BY i.id, r.id ORDER BY i.queued_at DESC LIMIT 1`,
  ]).trim();
}

async function waitForDemoState(expectedState) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const evidence = latestDemoEvidence();
    if (evidence.split('|')[3] === expectedState) return evidence;
    await wait(500);
  }
  throw new Error(`demo interaction ไม่เข้าสู่ ${expectedState}: ${latestDemoEvidence()}`);
}

function currentMedia() {
  return JSON.parse(
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
}

async function waitForInboundLeg(destination) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const media = currentMedia();
    const leg = (media.rows ?? []).find((row) => row.initial_dest === destination);
    if (leg?.uuid) return leg;
    await wait(500);
  }
  throw new Error(`ไม่พบ inbound leg ของ ${destination}`);
}

async function waitForActiveMedia(destination) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const media = currentMedia();
    const active = (media.rows ?? []).filter(
      (row) =>
        row.callstate === 'ACTIVE' && row.read_codec === 'PCMU' && row.write_codec === 'PCMU',
    );
    if (active.length >= 2 && active.some((row) => row.initial_dest === destination)) {
      return { media, active };
    }
    await wait(500);
  }
  throw new Error(`FreeSWITCH ไม่ยืนยัน media สอง leg ของ ${destination}`);
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

  start('pnpm', ['--filter', '@d-contact/router', 'dev'], {
    diagnostic: 'router',
    env: {
      ...process.env,
      ROUTER_INBOUND_VOICE_GROUP_ID: routerGroupId,
    },
  });
  start('pnpm', ['--filter', '@d-contact/telephony', 'dev'], {
    env: {
      ...process.env,
      TELEPHONY_NODE_ID: nodeId,
      FREESWITCH_AGENT_DIAL_TEMPLATE: `sofia/internal/{extension}@${agentContainer}:5060`,
    },
    diagnostic: 'telephony',
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
  await Promise.all([
    waitForConsumerGroup(routerGroupId),
    waitForConsumerGroup(`dcontact-telephony-command-${nodeId}-v1`),
  ]);
  resetPreviousDemoMedia();
  resetPreviousDemoInteractions();
  run('pnpm', ['db:seed']);
  await wait(1_000);

  const fixture = resolve(
    ivrDtmf ? 'scripts/fixtures/inbound-ivr-uac.xml' : 'scripts/fixtures/inbound-voice-uac.xml',
  );
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
  if (ivrDtmf) {
    await wait(5_500);
    const inboundLeg = await waitForInboundLeg('2001');
    run('docker', [
      ...compose,
      'exec',
      '-T',
      'freeswitch',
      'fs_cli',
      '-x',
      `uuid_recv_dtmf ${inboundLeg.uuid} ${ivrDtmf}`,
    ]);
  }
  const { active: activeMediaLegs } = await waitForActiveMedia(ivrDtmf ? '2001' : '2000');
  const callerExit = await new Promise((resolveExit) =>
    callerProcess.once('close', (code) => resolveExit(code)),
  );
  if (callerExit !== 0) throw new Error(`SIPp caller ล้มเหลว\n${caller}`);
  if (!caller.includes('Successful call') || !caller.match(/Successful call\s+\|\s+0\s+\|\s+1/)) {
    throw new Error(`SIPp ไม่ยืนยัน successful media call\n${caller}`);
  }
  const inboundLeg = activeMediaLegs.find(
    (row) => row.initial_dest === (ivrDtmf ? '2001' : '2000'),
  );
  if (!inboundLeg?.uuid) throw new Error('ไม่พบ inbound media leg สำหรับปิดสายทดสอบ');
  run('docker', [
    ...compose,
    'exec',
    '-T',
    'freeswitch',
    'fs_cli',
    '-x',
    `uuid_kill ${inboundLeg.uuid} NORMAL_CLEARING`,
  ]);

  const wrapupEvidence = await waitForDemoState('WRAPUP');
  const [
    tenantId,
    interactionId,
    agentId,
    ,
    observedNodeId,
    eventCount,
    recordingId,
    durationSec,
    archiveState,
  ] = wrapupEvidence.split('|');
  const minimumEventCount = ivrDtmf ? 6 : 5;
  // รายงานเป็นเงื่อนไขที่ไม่ผ่านทีละข้อ ไม่ใช่ evidence ทั้งก้อน เพราะข้อความเดิมบอกได้แค่ว่า
  // "ไม่ครบ" แล้วทิ้งให้ไปไล่เดาเองว่าค่าไหนผิด ซึ่งกิน field ที่ต่างกันคนละสาเหตุกันทั้งนั้น
  const unmet = [
    observedNodeId !== nodeId &&
      `telephonyNodeId ควรเป็น ${nodeId} แต่ได้ ${observedNodeId} — ตรวจว่า telephony node ที่รับสายคือ node ของ demo`,
    Number(eventCount) < minimumEventCount &&
      `event ของ interaction ควรมีอย่างน้อย ${minimumEventCount} แต่ได้ ${eventCount} — ตรวจ Router lifecycle`,
    !recordingId && 'ไม่มีแถวใน recordings — ตรวจ recording.start ของ telephony',
    Number(durationSec) < 1 &&
      `recording duration ควรมากกว่า 0 วินาที แต่ได้ ${durationSec} — ตรวจ recording.stop และ endedAt`,
    archiveState !== 'ARCHIVED' &&
      `recording ยังเป็น ${archiveState} — ตรวจ FREESWITCH_RECORDINGS_HOST_DIR, bucket ของ MinIO และ error ของ telephony`,
  ].filter(Boolean);
  if (unmet.length > 0) {
    throw new Error(
      `หลักฐาน recording/wrap-up ไม่ครบ (${unmet.length} ข้อ):\n  - ${unmet.join('\n  - ')}\n  evidence: ${wrapupEvidence}`,
    );
  }
  run('pnpm', [
    '--filter',
    '@d-contact/router',
    'demo:wrapup',
    '--',
    tenantId,
    interactionId,
    agentId,
    ivrDtmf ? 'IVR_DEMO_RESOLVED' : 'DIRECT_DEMO_RESOLVED',
  ]);
  const completedEvidence = await waitForDemoState('COMPLETED');
  console.log(
    `PHASE_ONE_EVIDENCE ${JSON.stringify({
      kind: ivrDtmf ? 'ivr-softphone-e2e' : 'direct-queue-softphone-e2e',
      tenantId,
      interactionId,
      state: 'COMPLETED',
      eventCount: Number(completedEvidence.split('|')[5]),
      recordingId,
      recordingDurationSec: Number(durationSec),
      recordingState: archiveState,
    })}`,
  );
  console.log(`INBOUND_VOICE_PHASE_1_DEMO_PASS ${completedEvidence}`);
} finally {
  await cleanup();
}
